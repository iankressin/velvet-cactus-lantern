"""bj run: materialize one pipeline's Dagster job in this process."""

import os
from collections.abc import Collection
from pathlib import Path

import dagster as dg
from dbt.cli.main import dbtRunner, dbtRunnerResult

from pipeline.cli import BadInput

# dbt's own logs and usage stats are off: the summary reports what matters, and the stats call the network.
DBT_FLAGS = ("--log-level", "none", "--no-send-anonymous-usage-stats")


def dbt(project: Path, *args: str) -> dbtRunnerResult:
    return dbtRunner().invoke([*args, "--project-dir", str(project), "--profiles-dir", str(project), *DBT_FLAGS])


def dbt_error(result: dbtRunnerResult) -> str:
    if result.exception is not None:
        message = str(result.exception)
    else:
        message = "; ".join(
            f"{r.node.name}: {r.message}" for r in result.result.results if str(r.status) in ("error", "fail")
        )
    return " ".join(message.split()) or "unknown error"


def parse_project(project: Path) -> None:
    """Writes target/manifest.json, which pipeline.definitions needs on import. On a fresh clone only
    `dagster dev` would write it otherwise."""
    result = dbt(project, "parse")
    if not result.success:
        raise BadInput(f"dbt parse failed: {dbt_error(result)}")


def load_definitions() -> tuple[dg.Definitions, Collection[str]]:
    from pipeline.definitions import defs
    from pipeline.schedules import PIPELINES

    return defs, PIPELINES


def first_line(text: str) -> str:
    return text.strip().splitlines()[0] if text.strip() else ""


def root_cause(error):
    """Dagster wraps an asset's own error in its execution error; the asset's error says what went wrong."""
    while error.cause is not None:
        error = error.cause
    return error


def wallet_assets_config(path: str | None) -> dict:
    """Run config that points every source at one wallet asset CSV, by its absolute path: each source
    reads the file from its own package folder."""
    if path is None:
        return {}
    csv = Path(path).resolve()
    if not csv.is_file():
        raise BadInput(f"no wallet asset CSV at {csv}")
    return {"resources": {"ingestion_env": {"config": {"WALLET_ASSETS_CSV": str(csv)}}}}


def materialize(defs: dg.Definitions, pipelines: Collection[str], name: str, run_config: dict | None = None) -> int:
    if name not in pipelines:
        raise BadInput(f"no pipeline named {name!r}; pipelines: {', '.join(pipelines)}")
    # With DAGSTER_HOME set, the run lands in the same history `dagster dev` shows.
    instance = dg.DagsterInstance.get() if os.environ.get("DAGSTER_HOME") else None
    result = defs.resolve_job_def(name).execute_in_process(run_config=run_config or {}, instance=instance, raise_on_error=False)
    if result.success:
        print(f"{name}: run {result.run_id} succeeded")
        return 0
    print(f"{name}: run {result.run_id} failed")
    failures = [event for event in result.all_events if event.is_step_failure]
    for event in failures:
        print(f"  step {event.step_key} failed: {first_line(root_cause(event.step_failure_data.error).message)}")
    if not failures:
        run_failure = next((event for event in result.all_events if event.is_run_failure), None)
        print(f"  no step failed: {first_line(run_failure.message) if run_failure else 'the run did not finish'}")
    return 1


def run(repo_root: Path, name: str, wallet_assets: str | None = None) -> int:
    run_config = wallet_assets_config(wallet_assets)
    parse_project(repo_root / "transformation")
    defs, pipelines = load_definitions()
    return materialize(defs, pipelines, name, run_config)
