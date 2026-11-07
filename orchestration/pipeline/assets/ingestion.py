import json
import logging
import os
import subprocess
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import dagster as dg
from dotenv import dotenv_values
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


SECRET_MARKERS = ("PASSWORD", "SECRET", "TOKEN", "API_KEY")
SECRET_SHOWN = "********"
DBT_KEYS = frozenset({"RAW_SCHEMA", "WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB"})


def effective_env(entry: SourceEntry, environ: Mapping[str, str]) -> dict[str, str]:
    """The value the source reads for each of its keys, in the order loadEnv in ingestion/lib/src/env.ts
    reads them: the environment, the chain's .env and .env.example, then the package's .env."""
    files = [entry.folder(REPO_ROOT) / ".env", entry.folder(REPO_ROOT) / ".env.example"] if entry.settings else []
    files.append(INGESTION_DIR / "sources" / entry.package / ".env")
    layers = [environ, *(dotenv_values(file) for file in files if file.is_file())]
    return {key: next((layer[key] for layer in layers if layer.get(key)), "") for key in env_settings(entry)}


def shown_value(key: str, value: str) -> str:
    return SECRET_SHOWN if value and any(marker in key for marker in SECRET_MARKERS) else value


def env_field(setting: EnvSetting, shown: str, notes: Iterable[str] = ()) -> dg.Field:
    lines = [
        setting.comment,
        f"Example: {setting.key}={setting.example} in {setting.repo_path}.",
        *notes,
        "dbt reads the root .env, so a changed value here loads rows dbt does not read." if setting.key in DBT_KEYS else "",
        "Change it to override it for this run only. Left as shown, the source reads its .env files.",
    ]
    # Any takes an unquoted YAML number as well as a string.
    return dg.Field(dg.Any, default_value=shown, is_required=False, description="\n".join(line for line in lines if line))


def env_overrides(config: Mapping[str, Any] | None, shown: Mapping[str, str]) -> dict[str, str]:
    """The values a run changed from what the Launchpad showed. A value left as shown, or emptied, sets
    nothing, so the source reads its .env files as it would without run config."""
    overrides = {}
    for key, value in (config or {}).items():
        if value is None or value == "":
            continue
        if isinstance(value, (Mapping, list)):
            raise dg.Failure(description=f"Run config for {key} must be a single value, not a mapping or a list")
        if str(value) != shown.get(key, ""):
            overrides[key] = str(value)
    return overrides


@dataclass(frozen=True)
class SourceEnv:
    """One source's keys and what the Launchpad shows for them: its own keys on the asset, the shared
    ones in the ingestion_env resource."""

    settings: Mapping[str, EnvSetting]
    own_shown: Mapping[str, str]
    shared_shown: Mapping[str, str]

    def overrides(self, shared_config: Mapping[str, Any] | None, own_config: Mapping[str, Any] | None) -> dict[str, str]:
        shared = env_overrides(shared_config, self.shared_shown)
        return {
            **{key: value for key, value in shared.items() if key in self.settings},
            **env_overrides(own_config, self.own_shown),
        }


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


def build_ingestion_asset(entry: SourceEntry, env: SourceEnv) -> dg.AssetsDefinition:
    source, table = entry.name, entry.table

    @dg.asset(
        key=[source, table],
        group_name="ingestion",
        kinds={"typescript", "postgres"},
        description=f"Runs `pnpm ingest` in ingestion/sources/{entry.package}. Run config overrides its env "
        "variables for one run. Keys only this source reads are set here, and shared keys in the ingestion_env "
        "resource.",
        config_schema={key: env_field(env.settings[key], shown) for key, shown in env.own_shown.items()} or None,
        required_resource_keys={"ingestion_env"},
    )
    def _ingest(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        overrides = env.overrides(context.resources.ingestion_env, context.op_execution_context.op_config)
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


def build_dead_letter_check(entry: SourceEntry, env: SourceEnv) -> dg.AssetChecksDefinition:
    source, table = entry.name, entry.table

    @dg.asset_check(
        asset=dg.AssetKey([source, table]),
        name="no_dead_letters",
        description="Calls that failed and wait in the raw schema's _dead_letters table. Warns, never blocks.",
    )
    def _check(context: dg.AssetCheckExecutionContext) -> dg.AssetCheckResult:
        # The check runs as its own step, so it reads the overrides from the run config, as the asset does.
        run_config = context.run.run_config
        overrides = env.overrides(
            run_config.get("resources", {}).get("ingestion_env", {}).get("config"),
            run_config.get("ops", {}).get(f"{source}__{table}", {}).get("config"),
        )
        pending, parked = count_dead_letters(f"{source}_{table}", {**os.environ, **overrides})
        return dg.AssetCheckResult(
            passed=pending + parked == 0,
            severity=dg.AssetCheckSeverity.WARN,
            metadata={"pending": pending, "parked": parked},
        )

    return _check


def ingestion_definitions(
    environ: Mapping[str, str] = os.environ,
) -> tuple[list[dg.AssetsDefinition], list[dg.AssetChecksDefinition], dg.ResourceDefinition]:
    """The ingestion assets, their dead-letter checks, and the ingestion_env resource that holds every key two or more sources read,
    so a run sets such a key once. Each field shows the value its source reads now."""
    settings = {entry: env_settings(entry) for entry in ENTRIES}
    values = {entry: effective_env(entry, environ) for entry in ENTRIES}
    readers: dict[str, list[SourceEntry]] = defaultdict(list)
    for entry in ENTRIES:
        for key in settings[entry]:
            readers[key].append(entry)

    shared_shown, shared_fields = {}, {}
    for key, entries in readers.items():
        if len(entries) < 2:
            continue
        found = {f"{entry.name}.{entry.table}": shown_value(key, values[entry][key]) for entry in entries}
        agreed = len(set(found.values())) == 1
        shared_shown[key] = next(iter(found.values())) if agreed else ""
        notes = [f"Applies to {', '.join(found)}."]
        if not agreed:
            reads = ", ".join(f"{label}={value or 'nothing'}" for label, value in found.items())
            notes.append(f"They read {reads}.")
        shared_fields[key] = env_field(settings[entries[0]][key], shared_shown[key], notes)

    resource = dg.resource(
        config_schema=shared_fields,
        description="Env variables two or more ingestion sources read. A changed value overrides the variable "
        "for every source that reads it, for that run only.",
    )(lambda init_context: init_context.resource_config)
    envs = {
        entry: SourceEnv(
            settings[entry],
            {key: shown_value(key, values[entry][key]) for key in settings[entry] if key not in shared_shown},
            shared_shown,
        )
        for entry in ENTRIES
    }
    assets = [build_ingestion_asset(entry, envs[entry]) for entry in ENTRIES]
    checks = [build_dead_letter_check(entry, envs[entry]) for entry in ENTRIES]
    return assets, checks, resource


ingestion_assets, ingestion_checks, ingestion_env = ingestion_definitions()
