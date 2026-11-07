"""blockjuice, or bj: the mechanical steps of answering a question from the warehouse.

Exit codes: 0 success, 1 the command ran but a check failed (`answer`, or `check` recording a failed
one), 2 bad input or config, reported as one line on stderr, with nothing written.
"""

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
REQUIRED_ENV = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB", "RAW_SCHEMA")


class BadInput(Exception):
    """Bad input or config. main prints the message as one line and exits 2."""


def require_env() -> None:
    """The warehouse settings that dbt, ingestion and bj share."""
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise BadInput(f"set {', '.join(missing)} in .env")


def utc_iso(moment: datetime) -> str:
    """ISO 8601 in UTC, ending in Z. A datetime without an offset is already UTC."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# Each command imports its module only when it runs, so `bj blocks` does not load dbt or Dagster.
def _answer(args: argparse.Namespace) -> int:
    from pipeline.cli import answer

    return answer.run(REPO_ROOT, args.slug)


def _blocks(args: argparse.Namespace) -> int:
    from pipeline.cli import blocks

    return blocks.run(args.chain, args.start, args.end, rpc=args.rpc)


def _check(args: argparse.Namespace) -> int:
    from pipeline.cli import check

    return check.run(REPO_ROOT, args.slug, args.name, args.status, " ".join(args.detail))


def _coverage(args: argparse.Namespace) -> int:
    from pipeline.cli import coverage

    return coverage.run(REPO_ROOT, args.source)


def _dev(args: argparse.Namespace) -> int:
    from pipeline.cli import dev

    return dev.run(REPO_ROOT)


def _doctor(args: argparse.Namespace) -> int:
    from pipeline.cli import doctor

    return doctor.run(REPO_ROOT, args.copy_env)


def _install(args: argparse.Namespace) -> int:
    from pipeline.cli import install

    return install.run(REPO_ROOT)


def _new_source(args: argparse.Namespace) -> int:
    from pipeline.cli import new_source

    return new_source.run(REPO_ROOT, args.source, args.table, args.like)


def _report(args: argparse.Namespace) -> int:
    from pipeline.cli import report

    return report.run(REPO_ROOT, args.slug, args.format)


def _run(args: argparse.Namespace) -> int:
    from pipeline.cli import run

    return run.run(REPO_ROOT, args.pipeline)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="The mechanical steps of answering a question about chain data.")
    commands = root.add_subparsers(dest="command", required=True, metavar="<command>")

    answer = commands.add_parser(
        "answer",
        help="run a question's dbt analyses and check the data behind them",
        description="Reads answers/<slug>/question.yaml, compiles and runs its dbt analyses on the warehouse, "
        "runs the dbt tests upstream of them, checks the dead letters and freshness of every raw table they "
        "read, and writes answers/<slug>/results/ and answer.json. Exits 1 when a check fails.",
    )
    answer.add_argument("slug")
    answer.set_defaults(run=_answer)

    blocks = commands.add_parser(
        "blocks",
        help="the block range of an EVM chain that covers a time window",
        description="Prints the first block at or after <from> and the last block before <to>, as JSON. "
        "Times are ISO 8601 dates or datetimes, read as UTC. Without <to>, the range runs to the head. "
        "Reads block timestamps from the chain's SQD Portal dataset.",
    )
    blocks.add_argument("chain", help="an EVM chain, such as ethereum, arbitrum or base; an unknown name lists the rest")
    blocks.add_argument("start", metavar="from")
    blocks.add_argument("end", metavar="to", nargs="?")
    blocks.add_argument("--rpc", metavar="URL", help="read a JSON-RPC endpoint instead of Portal")
    blocks.set_defaults(run=_blocks)

    check = commands.add_parser(
        "check",
        help="add a check you ran yourself, such as cross_check, to answer.json",
        description="Adds the check to answers/<slug>/answer.json, or replaces the one with the same name. "
        "Exits 0 when it passed and 1 when it failed. bj answer drops these checks when it runs again, "
        "since new results void them.",
    )
    check.add_argument("slug")
    check.add_argument("name", help="such as cross_check; not one of the checks bj answer runs")
    check.add_argument("status", choices=("passed", "failed"))
    check.add_argument("detail", nargs="+", help="what the check compared, and what it found")
    check.set_defaults(run=_check)

    coverage = commands.add_parser(
        "coverage",
        help="the blocks and addresses each stream source has loaded",
        description="Prints, as JSON, each stream source's START_BLOCK and the file that sets it, the cursor "
        "Pipes keeps in the warehouse, its addresses.json as the filter, and covered: [START_BLOCK, cursor], "
        "or null before its first run. A stream source is an entry of ingestion/sources.json whose package's "
        ".env.example sets START_BLOCK. With <source>.<table>, prints that source alone.",
    )
    coverage.add_argument("source", metavar="<source>.<table>", nargs="?")
    coverage.set_defaults(run=_coverage)

    dev = commands.add_parser(
        "dev",
        help="bj install, then start the compose stack, check it, and run dagster dev",
        description="Runs bj install, then docker compose up -d, which returns once warehouse-init has set up "
        "the warehouse. Then runs the checks of bj doctor, less Dagster's port, and replaces bj with dagster dev in "
        "orchestration/, so Ctrl-C stops Dagster. Exits 2 when port 3000 is in use or docker or pnpm is missing, "
        "and 1 when a step or a check failed, without starting Dagster.",
    )
    dev.set_defaults(run=_dev)

    doctor = commands.add_parser(
        "doctor",
        help="check the local setup: env files and keys, ports, the warehouse, eRPC, Dshackle, tool versions",
        description="Checks that .env and each source package's .env exist and set every key their .env.example "
        "requires, that the compose ports are open, that the warehouse answers, that eRPC and Dshackle report "
        "healthy, and that node, pnpm and uv match mise.toml. Prints one PASS, WARN or FAIL line per check and "
        "names keys without their values. Exits 1 when a check failed.",
    )
    doctor.add_argument(
        "--copy-env", action="store_true", help="copy .env.example to .env in each source package that has none"
    )
    doctor.set_defaults(run=_doctor)

    install = commands.add_parser(
        "install",
        help="set up a checkout: the .env files, the pnpm packages, the dbt manifest; starts nothing",
        description="Copies .env.example to .env at the root and in each source package that has none, and "
        "checks each .env as bj doctor does. Then runs pnpm install --frozen-lockfile in ingestion/ and dbt "
        "parse, which writes transformation/target/manifest.json. Never overwrites an .env, and is safe to run "
        "again. Exits 2 when pnpm is missing, and 1 when an .env lacks a required key or pnpm fails.",
    )
    install.set_defaults(run=_install)

    new_source = commands.add_parser(
        "new-source",
        help="add a source: copy a source package, add its dbt source, regenerate ingestion/sources.json",
        description="Copies ingestion/sources/<package> to a new package for <source>.<table>, adds the table "
        "to the dbt sources of <source> with a staging model, then runs pnpm install and pnpm generate-sources "
        "in ingestion/, which rewrites ingestion/sources.json, the list Dagster builds its SOURCES from. "
        "Reading the source from a mart and scheduling it in PIPELINES stay hand steps: see Adding a chain "
        "in transformation/README.md.",
    )
    new_source.add_argument("source")
    new_source.add_argument("table")
    new_source.add_argument("--like", metavar="<package>", required=True, help="the package under ingestion/sources/ to copy")
    new_source.set_defaults(run=_new_source)

    report = commands.add_parser(
        "report",
        help="write an answer as an XLSX workbook, a PDF, a DOCX or a Google Doc",
        description="Reads answers/<slug>/answer.json, answer.md and results/, and writes "
        "answers/<slug>/reports/<slug>.xlsx, .pdf or .docx. gdoc uploads the DOCX to Google Drive as a "
        "Google Doc and keeps its id in reports/<slug>.gdoc.json, so a rerun updates the same Doc.",
    )
    report.add_argument("slug")
    report.add_argument(
        "--format", default="xlsx,pdf", help="comma-separated: xlsx, pdf, docx, gdoc (default: xlsx,pdf)"
    )
    report.set_defaults(run=_report)

    run = commands.add_parser(
        "run",
        help="materialize one pipeline's Dagster job: ingestion, then dbt",
        description="Parses the dbt project, then runs the Dagster job of <pipeline> in this process. "
        "Exits 1 when the run fails, naming the steps that failed.",
    )
    run.add_argument("pipeline")
    run.set_defaults(run=_run)

    return root


def main(argv: list[str] | None = None) -> int:
    load_dotenv(REPO_ROOT / ".env", override=False)
    cli = parser()
    args = cli.parse_args(argv)
    try:
        return args.run(args)
    except BadInput as error:
        print(f"{cli.prog}: error: {error}", file=sys.stderr)
        return 2
