import json
import logging
import os
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import dagster as dg
from dotenv.parser import Binding, parse_stream

from pipeline.project import INGESTION_DIR, REPO_ROOT
from pipeline.sources import SOURCES_FILE, SourceEntry, read_sources
from pipeline.warehouse import count_dead_letters

# (source name, table name) pairs, from ingestion/sources.json: the `name` and `table` each package
# exports, which `pnpm generate-sources` writes there. Each must match a source table in the dbt
# project; dagster-dbt keys dbt sources the same way.
ENTRIES = read_sources((REPO_ROOT / SOURCES_FILE).read_text())
SOURCES = [(entry.name, entry.table) for entry in ENTRIES]
PACKAGES = {(entry.name, entry.table): entry.package for entry in ENTRIES}


def package_dir(source: str, table: str):
    return INGESTION_DIR / "sources" / PACKAGES[(source, table)]


@dataclass(frozen=True)
class EnvSetting:
    key: str
    example: str
    comment: str
    repo_path: Path


def follows_blank_line(binding: Binding) -> bool:
    # The parser folds blank lines into the start of the next binding.
    text = binding.original.string
    return "\n" in text[: len(text) - len(text.lstrip())]


def read_env_example(path: Path) -> dict[str, EnvSetting]:
    settings = {}
    comment: list[str] = []
    with path.open() as stream:
        for binding in parse_stream(stream):
            if follows_blank_line(binding):
                comment = []
            line = binding.original.string.lstrip()
            if binding.key is not None:
                repo_path = path.relative_to(REPO_ROOT)
                settings[binding.key] = EnvSetting(binding.key, binding.value or "", " ".join(comment), repo_path)
                comment = []
            elif line.startswith("#"):
                comment.append(line.lstrip("#").strip())
            else:
                comment = []
    return settings


def env_settings(entry: SourceEntry) -> dict[str, EnvSetting]:
    package = read_env_example(INGESTION_DIR / "sources" / entry.package / ".env.example")
    chain = read_env_example(entry.folder(REPO_ROOT) / ".env.example") if entry.settings else {}
    return {**package, **chain}


def describe(setting: EnvSetting) -> str:
    lines = [
        setting.comment,
        f"Example: {setting.key}={setting.example} in {setting.repo_path}.",
        "Leave it empty to keep the value from the .env files and the environment.",
    ]
    return "\n".join(line for line in lines if line)


def config_schema(settings: Mapping[str, EnvSetting]) -> dict[str, dg.Field]:
    # "Scaffold all default config" writes only fields with a default. Any takes an unquoted YAML number
    # as well as a string.
    return {
        key: dg.Field(dg.Any, default_value="", is_required=False, description=describe(setting))
        for key, setting in settings.items()
    }


def env_overrides(config: Mapping[str, Any]) -> dict[str, str]:
    overrides = {}
    for key, value in config.items():
        if value is None or value == "":
            continue
        if isinstance(value, (Mapping, list)):
            raise dg.Failure(description=f"Run config for {key} must be a single value, not a mapping or a list")
        overrides[key] = str(value)
    return overrides


def check_env(run_config: Mapping[str, Any], source: str, table: str) -> dict[str, str]:
    op_config = run_config.get("ops", {}).get(f"{source}__{table}", {}).get("config", {})
    return {**os.environ, **env_overrides(op_config)}


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


def build_ingestion_asset(entry: SourceEntry) -> dg.AssetsDefinition:
    source, table = entry.name, entry.table

    @dg.asset(
        key=[source, table],
        group_name="ingestion",
        kinds={"typescript", "postgres"},
        description=f"Runs `pnpm ingest` in ingestion/sources/{entry.package}, and run config overrides "
        "its env variables for that run only.",
        config_schema=config_schema(env_settings(entry)),
    )
    def _ingest(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        overrides = env_overrides(context.op_execution_context.op_config)
        if overrides:
            context.log.info(f"Run config overrides {', '.join(overrides)}")
        result = subprocess.run(
            ["pnpm", "--silent", "ingest"],
            cwd=package_dir(source, table),
            # The source writes the run id into ops.ingestion_runs, next to the dbt results of the same run.
            # CHAIN tells a package that loads several chains which one this asset is.
            env={**os.environ, **overrides, "DAGSTER_RUN_ID": context.run_id, "CHAIN": source},
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
    def _check(context: dg.AssetCheckExecutionContext) -> dg.AssetCheckResult:
        pending, parked = count_dead_letters(
            f"{source}_{table}", check_env(context.run.run_config, source, table)
        )
        return dg.AssetCheckResult(
            passed=pending + parked == 0,
            severity=dg.AssetCheckSeverity.WARN,
            metadata={"pending": pending, "parked": parked},
        )

    return _check


ingestion_assets = [build_ingestion_asset(entry) for entry in ENTRIES]
ingestion_checks = [build_dead_letter_check(source, table) for source, table in SOURCES]
