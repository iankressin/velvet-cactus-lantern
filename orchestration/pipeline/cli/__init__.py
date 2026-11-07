"""blockjuice, or bj: set up a checkout, check it, and run its pipelines.

Exit codes: 0 success, 1 the command ran but a check or step failed, 2 bad input or config, reported as
one line on stderr.
"""

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
REQUIRED_ENV = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB", "RAW_SCHEMA")


class BadInput(Exception):
    """Bad input or config. main prints the message as one line and exits 2."""


# Each command imports its module only when it runs, so `bj doctor` does not load dbt or Dagster.
def _dev(args: argparse.Namespace) -> int:
    from pipeline.cli import dev

    return dev.run(REPO_ROOT)


def _doctor(args: argparse.Namespace) -> int:
    from pipeline.cli import doctor

    return doctor.run(REPO_ROOT, args.copy_env)


def _install(args: argparse.Namespace) -> int:
    from pipeline.cli import install

    return install.run(REPO_ROOT)


def _run(args: argparse.Namespace) -> int:
    from pipeline.cli import run

    return run.run(REPO_ROOT, args.pipeline)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Set up a BlockJuice checkout, check it, and run its pipelines.")
    commands = root.add_subparsers(dest="command", required=True, metavar="<command>")

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
