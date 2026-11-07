import json
import logging
import os
import subprocess

import dagster as dg

from pipeline.project import INGESTION_DIR, REPO_ROOT
from pipeline.sources import SOURCES_FILE, read_sources
from pipeline.warehouse import count_dead_letters

# (source name, table name) pairs, from ingestion/sources.json: the `name` and `table` each package
# exports, which `pnpm generate-sources` writes there. Each must match a source table in the dbt
# project; dagster-dbt keys dbt sources the same way.
ENTRIES = read_sources((REPO_ROOT / SOURCES_FILE).read_text())
SOURCES = [(entry.name, entry.table) for entry in ENTRIES]
PACKAGES = {(entry.name, entry.table): entry.package for entry in ENTRIES}


def package_dir(source: str, table: str):
    return INGESTION_DIR / "sources" / PACKAGES[(source, table)]


PINO_LEVELS = {
    10: logging.DEBUG,
    20: logging.DEBUG,
    30: logging.INFO,
    40: logging.WARNING,
    50: logging.ERROR,
    60: logging.CRITICAL,
}
# Fields on every line, fields the asset key already shows, and the error, which gets its own line.
PINO_HIDDEN_FIELDS = {"level", "time", "pid", "hostname", "msg", "source", "table", "err"}


def parse_log_line(line: str) -> tuple[int, str]:
    """A pino JSON line becomes its logging level and a message. Any other line logs as info."""
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return logging.INFO, line
    if not isinstance(entry, dict) or entry.get("level") not in PINO_LEVELS:
        return logging.INFO, line
    fields = " ".join(
        f"{key}={json.dumps(value)}" for key, value in entry.items() if key not in PINO_HIDDEN_FIELDS
    )
    message = " ".join(part for part in (entry.get("msg", ""), fields) if part)
    err = entry.get("err")
    if isinstance(err, dict):
        message += "\n" + err.get("stack", err.get("message", ""))
    return PINO_LEVELS[entry["level"]], message


def build_ingestion_asset(source: str, table: str) -> dg.AssetsDefinition:
    @dg.asset(
        key=[source, table],
        group_name="ingestion",
        kinds={"typescript", "postgres"},
    )
    def _ingest(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        result = subprocess.run(
            ["pnpm", "--silent", "ingest"],
            cwd=package_dir(source, table),
            # The source writes the run id into ops.ingestion_runs, next to the dbt results of the same run.
            # CHAIN tells a package that loads several chains which one this asset is.
            env={**os.environ, "DAGSTER_RUN_ID": context.run_id, "CHAIN": source},
            capture_output=True,
            text=True,
        )
        errors = []
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            level, message = parse_log_line(line)
            context.log.log(level, message)
            if level >= logging.ERROR:
                errors.append(message)
        if result.stderr and result.returncode == 0:
            context.log.warning(result.stderr)
        if result.returncode != 0:
            raise dg.Failure(
                description=f"Ingestion for {source} exited with code {result.returncode}",
                metadata={
                    "errors": dg.MetadataValue.text("\n".join(errors)),
                    "stderr": dg.MetadataValue.text(result.stderr),
                },
            )
        return dg.MaterializeResult()

    return _ingest


def build_dead_letter_check(source: str, table: str) -> dg.AssetChecksDefinition:
    @dg.asset_check(
        asset=dg.AssetKey([source, table]),
        name="no_dead_letters",
        description="Calls that failed and wait in the raw schema's _dead_letters table. Warns, never blocks.",
    )
    def _check() -> dg.AssetCheckResult:
        pending, parked = count_dead_letters(f"{source}_{table}")
        return dg.AssetCheckResult(
            passed=pending + parked == 0,
            severity=dg.AssetCheckSeverity.WARN,
            metadata={"pending": pending, "parked": parked},
        )

    return _check


ingestion_assets = [build_ingestion_asset(source, table) for source, table in SOURCES]
ingestion_checks = [build_dead_letter_check(source, table) for source, table in SOURCES]
