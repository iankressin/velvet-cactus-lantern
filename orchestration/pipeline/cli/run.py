"""bj run: materialize one pipeline's Dagster job in this process."""

import os
from collections.abc import Collection
from pathlib import Path

import dagster as dg

from pipeline.cli import BadInput
from pipeline.cli.answer import dbt, dbt_error


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


def materialize(defs: dg.Definitions, pipelines: Collection[str], name: str) -> int:
    if name not in pipelines:
        raise BadInput(f"no pipeline named {name!r}; pipelines: {', '.join(pipelines)}")
    # With DAGSTER_HOME set, the run lands in the same history `dagster dev` shows.
    instance = dg.DagsterInstance.get() if os.environ.get("DAGSTER_HOME") else None
    result = defs.resolve_job_def(name).execute_in_process(instance=instance, raise_on_error=False)
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


def run(repo_root: Path, name: str) -> int:
    parse_project(repo_root / "transformation")
    defs, pipelines = load_definitions()
    return materialize(defs, pipelines, name)
