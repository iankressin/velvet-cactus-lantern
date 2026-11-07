"""bj answer: run a question's dbt analyses on the warehouse and check the data behind them."""

import csv
import json
import math
import shutil
import subprocess
from collections import Counter
from collections.abc import Collection, Iterable, Sequence
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from dbt.cli.main import dbtRunner, dbtRunnerResult
from dbt.version import __version__ as dbt_version

from pipeline.cli import BadInput, coverage, require_env, utc_iso
from pipeline.cli.coverage import Coverage
from pipeline.cli.question import Question, SourceInput, load_question
from pipeline.warehouse import connect, count_dead_letters

# dbt's own logs and usage stats are off: the summary reports what matters, and the stats call the network.
DBT_FLAGS = ("--log-level", "none", "--no-send-anonymous-usage-stats")
# JSON readers parse numbers as doubles, which hold integers exactly only up to here.
MAX_SAFE_INTEGER = 2**53 - 1


@dataclass(frozen=True, order=True)
class Input:
    """A raw table an answer reads, found through the dbt sources its analyses depend on."""

    source: str
    table: str
    raw_table: str

    @property
    def name(self) -> str:
        return f"{self.source}.{self.table}"

    @property
    def source_table(self) -> str:
        """The key of the input's dead letters."""
        return f"{self.source}_{self.table}"


@dataclass(frozen=True)
class LastRun:
    finished_at: datetime
    records_written: int
    dagster_run_id: str | None


@dataclass(frozen=True)
class Result:
    analysis: str
    sql: str
    columns: list[str]
    rows: list[tuple]


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


def upstream_inputs(manifest: dict, unique_ids: Iterable[str]) -> list[Input]:
    """The dbt sources the given nodes depend on, directly or through other nodes."""
    found, seen, stack = set(), set(), list(unique_ids)
    while stack:
        unique_id = stack.pop()
        if unique_id in seen:
            continue
        seen.add(unique_id)
        if unique_id in manifest["sources"]:
            source = manifest["sources"][unique_id]
            found.add(Input(source["source_name"], source["name"], f"{source['schema']}.{source['identifier']}"))
        else:
            stack.extend(manifest["nodes"].get(unique_id, {}).get("depends_on", {}).get("nodes", []))
    return sorted(found)


def jsonable(value: Any) -> Any:
    """A value JSON can hold without losing precision: big integers and decimals become strings."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= MAX_SAFE_INTEGER else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return utc_iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    return str(value)


def cell_text(value: Any) -> str:
    """A warehouse value as CSV text, written exactly: no float conversion, None as empty."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(jsonable(value))
    converted = jsonable(value)
    return converted if isinstance(converted, str) else str(converted)


def headline(results: Sequence[Result]) -> Any:
    """The first analysis's only cell, when it returns exactly one row of one column."""
    first = results[0]
    if len(first.columns) == 1 and len(first.rows) == 1:
        return first.rows[0][0]
    return None


def dbt_tests_check(statuses: Iterable[tuple[str, str]]) -> Check:
    """From each test's (name, status): passed when no test failed or errored. Names the tests that warned or failed."""
    statuses = list(statuses)
    failed = sorted(name for name, status in statuses if status in ("fail", "error"))
    warned = sorted(name for name, status in statuses if status == "warn")
    counts = Counter(status for _, status in statuses)
    parts = [f"{counts['pass']} passed"]
    if warned:
        parts.append(f"{len(warned)} warned: {', '.join(warned)}")
    if counts["skipped"]:
        parts.append(f"{counts['skipped']} skipped")
    if failed:
        parts.append(f"{len(failed)} failed: {', '.join(failed)}")
    return Check("dbt_tests", not failed, ", ".join(parts))


def dead_letters_check(counts: dict[Input, tuple[int, int]]) -> Check:
    detail = "; ".join(f"{i.name} {pending} pending, {parked} parked" for i, (pending, parked) in counts.items())
    return Check("dead_letters", all(sum(c) == 0 for c in counts.values()), detail or "no inputs")


def freshness_check(last_runs: dict[Input, LastRun | None]) -> Check:
    detail = "; ".join(
        f"{i.name} finished {utc_iso(run.finished_at)}" if run else f"{i.name} has no successful run"
        for i, run in last_runs.items()
    )
    return Check("freshness", all(last_runs.values()), detail or "no inputs")


def stream_inputs(
    question: Question, inputs: Iterable[Input], sources: Collection[str], streams: Collection[str]
) -> list[SourceInput]:
    """The question's inputs that read a stream source. Every stream source the analyses read needs one,
    so its filter is on record, and the question then needs window.blocks. An input's source must be in SOURCES.
    A source on a chain that window.blocks leaves out needs none: a mart that stacks chains reads it, but the
    analyses keep to the window's chains."""
    label = f"answers/{question.slug}/question.yaml"
    for i in question.sources:
        if i.source not in sources:
            raise BadInput(
                f"{label}: an input names {i.source}, which is not in SOURCES; stream sources: {', '.join(streams) or 'none'}"
            )
    declared = [i for i in question.sources if i.source in streams]
    named = {i.source for i in declared}
    for read in inputs:
        outside_window = bool(question.blocks) and read.name.split(".")[0] not in question.blocks
        if read.name in streams and read.name not in named and not outside_window:
            raise BadInput(
                f"{label}: the analyses read the stream source {read.name}; "
                f"add an input with source: {read.name} and the filter it needs"
            )
    if declared and not question.blocks:
        raise BadInput(f"{label}: inputs read the stream source {', '.join(sorted(named))}, so set window.blocks: [from, to]")
    return declared


def coverage_check(
    inputs: Iterable[SourceInput], coverages: dict[str, Coverage], blocks: dict[str, tuple[int, int]]
) -> Check:
    """Passed when each stream input's source has loaded every block of the window on its chain, for the
    addresses its filter names."""
    details, passed = [], True
    for i in inputs:
        loaded = coverages[i.source]
        span = f"loaded {loaded.start_block}-{loaded.cursor}" if loaded.cursor is not None else "nothing loaded"
        window = blocks.get(i.chain)
        gaps = loaded.gaps(window, i.filter) if window else [f"window.blocks has no blocks for {i.chain}"]
        passed = passed and not gaps
        details.append(
            f"{i.source} ({span}): {', '.join(gaps)}"
            if gaps
            else f"{i.source} ({span}) covers blocks {window[0]}-{window[1]} and the filter"
        )
    return Check("coverage", passed, "; ".join(details))


def answer_document(
    question: Question,
    answered_at: datetime,
    results: Sequence[Result],
    dead_letters: dict[Input, tuple[int, int]],
    last_runs: dict[Input, LastRun | None],
    checks: Sequence[Check],
    provenance: dict[str, Any],
) -> dict[str, Any]:
    """answer.json, in the key order readers expect."""
    return {
        "question": question.question,
        "slug": question.slug,
        "answered_at": utc_iso(answered_at.replace(microsecond=0)),
        "value": jsonable(headline(results)),
        "definitions": question.definitions,
        "alternatives": list(question.alternatives),
        "window": jsonable(question.window),
        "results": [
            {
                "analysis": result.analysis,
                "path": f"results/{result.analysis}.csv",
                "columns": result.columns,
                "rows": len(result.rows),
                "sql": result.sql,
            }
            for result in results
        ],
        "inputs": [
            {
                "source": i.name,
                "raw_table": i.raw_table,
                "last_run": jsonable(asdict(last_runs[i])) if last_runs[i] else None,
                "dead_letters": {"pending": pending, "parked": parked},
            }
            for i, (pending, parked) in dead_letters.items()
        ],
        "checks": [{"name": c.name, "status": "passed" if c.passed else "failed", "detail": c.detail} for c in checks],
        "provenance": provenance,
    }


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


def compile_analyses(project: Path, names: Sequence[str]) -> tuple[dict, list[str]]:
    """The manifest after `dbt compile`, and the unique id of each analysis."""
    result = dbt(project, "compile", "--select", *names)
    if not result.success:
        raise BadInput(f"dbt compile failed: {dbt_error(result)}")
    manifest = json.loads((project / "target" / "manifest.json").read_text())
    analyses = {node["name"]: uid for uid, node in manifest["nodes"].items() if node["resource_type"] == "analysis"}
    for name in names:
        if name not in analyses:
            raise BadInput(f"no dbt analysis named {name}: write transformation/analyses/{name}.sql")
    return manifest, [analyses[name] for name in names]


def run_dbt_tests(project: Path, names: Sequence[str], coverages: dict[str, Coverage]) -> Check:
    """The dbt tests upstream of the analyses. Tests that reconcile history with state, such as
    tests/erc20_transfers_match_balances.sql, read what each stream source loaded from var('coverage')."""
    loaded = {name: c.to_json() for name, c in coverages.items()}
    variables = ("--vars", json.dumps({"coverage": loaded})) if loaded else ()
    result = dbt(project, "test", "--select", *(f"+{name}" for name in names), *variables)
    if result.exception is not None:
        raise BadInput(f"dbt test could not run: {dbt_error(result)}")
    return dbt_tests_check((r.node.name, str(r.status)) for r in result.result.results)


def last_successful_run(cursor, source: Input) -> LastRun | None:
    cursor.execute(
        "select finished_at, records_written, dagster_run_id from ops.ingestion_runs"
        " where source = %s and table_name = %s and succeeded order by finished_at desc limit 1",
        (source.source, source.table),
    )
    row = cursor.fetchone()
    return LastRun(*row) if row else None


def read_warehouse(manifest: dict, analysis_ids: Sequence[str], inputs: Sequence[Input]):
    try:
        connection = connect()
    except psycopg2.Error as error:
        raise BadInput(f"could not connect to the warehouse: {' '.join(str(error).split())}") from None
    with closing(connection):
        # Analyses only read; a read-only session makes sure of it.
        connection.set_session(readonly=True)
        results = []
        for unique_id in analysis_ids:
            node = manifest["nodes"][unique_id]
            with connection.cursor() as cursor:
                try:
                    cursor.execute(node["compiled_code"])
                except psycopg2.Error as error:
                    raise BadInput(f"analysis {node['name']} failed: {' '.join(str(error).split())}") from None
                if cursor.description is None:
                    raise BadInput(f"analysis {node['name']} returned no columns: an analysis must be a select")
                columns = [column.name for column in cursor.description]
                results.append(Result(node["name"], node["compiled_code"], columns, cursor.fetchall()))
            connection.rollback()
        try:
            with connection.cursor() as cursor:
                last_runs = {i: last_successful_run(cursor, i) for i in inputs}
            dead_letters = {i: count_dead_letters(i.source_table) for i in inputs}
        except psycopg2.Error as error:
            raise BadInput(f"could not read the run log or dead letters: {' '.join(str(error).split())}") from None
    return results, dead_letters, last_runs


def git(repo_root: Path, *args: str) -> str | None:
    done = subprocess.run(["git", "-C", str(repo_root), *args], capture_output=True, text=True, check=False)
    return done.stdout.strip() if done.returncode == 0 else None


def provenance(repo_root: Path) -> dict[str, Any]:
    # answers/ is this command's own output, so it does not make the code that produced it dirty.
    status = git(repo_root, "status", "--porcelain", "--", ".", ":(exclude)answers")
    return {
        "git_sha": git(repo_root, "rev-parse", "HEAD"),
        "git_dirty": bool(status) if status is not None else None,
        "dbt_version": dbt_version,
    }


def write_answer(folder: Path, results: Sequence[Result], document: dict[str, Any]) -> None:
    results_dir = folder / "results"
    shutil.rmtree(results_dir, ignore_errors=True)
    results_dir.mkdir()
    for result in results:
        with open(results_dir / f"{result.analysis}.csv", "w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file, lineterminator="\n")
            writer.writerow(result.columns)
            writer.writerows([cell_text(value) for value in row] for row in result.rows)
    (folder / "answer.json").write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run(repo_root: Path, slug: str) -> int:
    question = load_question(repo_root, slug)
    require_env()
    project = repo_root / "transformation"
    manifest, analysis_ids = compile_analyses(project, question.analyses)
    inputs = upstream_inputs(manifest, analysis_ids)
    streams = stream_inputs(question, inputs, coverage.sources(repo_root), coverage.stream_sources(repo_root))
    coverages = {name: coverage.read(repo_root, name) for name in sorted({i.source for i in streams})}
    tests = run_dbt_tests(project, question.analyses, coverages)
    results, dead_letters, last_runs = read_warehouse(manifest, analysis_ids, inputs)
    checks = [tests, dead_letters_check(dead_letters), freshness_check(last_runs)]
    if streams:
        checks.append(coverage_check(streams, coverages, question.blocks))
    document = answer_document(
        question, datetime.now(timezone.utc), results, dead_letters, last_runs, checks, provenance(repo_root)
    )
    folder = repo_root / "answers" / slug
    write_answer(folder, results, document)

    value = document["value"]
    print(f"value: {value if value is not None else 'none (the first analysis is not one row of one column)'}")
    for check in checks:
        print(f"{check.name}: {'passed' if check.passed else 'FAILED'} ({check.detail})")
    print(f"wrote answers/{slug}/answer.json and {len(results)} CSV file(s) in answers/{slug}/results/")
    return 0 if all(check.passed for check in checks) else 1
