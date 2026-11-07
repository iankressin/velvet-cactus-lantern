"""bj new-source: add a source by copying a source package, with its dbt source, and regenerate sources.json."""

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

from pipeline.cli import BadInput
from pipeline.sources import SOURCES_FILE, read_sources

NAME = re.compile(r"^[a-z][a-z0-9_]*$")
# pnpm install links the new package into the workspace, which the generator needs to import it.
GENERATE = (["pnpm", "install"], ["pnpm", "--silent", "generate-sources"])


@dataclass(frozen=True)
class Plan:
    """Everything the command writes, worked out before it writes any of it."""

    template: Path
    package: Path
    files: dict[Path, str]
    # For a template that loads several chains: the template's chain folder to copy, and the new
    # package's folder for the requested chain. The new package gets no other chain.
    chain: tuple[Path, Path] | None = None


def package_name(source: str, table: str) -> str:
    """The folder of a new package under ingestion/sources/. sources.json records each existing package's folder."""
    return f"{source}-{table.replace('_', '-')}"


def source_tables(text: str, source: str, path: Path) -> list[str]:
    """The tables of `source` in a dbt sources yml."""
    try:
        document = yaml.safe_load(text)
        matches = [s for s in document["sources"] if s["name"] == source]
        return [t["name"] for m in matches for t in m.get("tables") or []]
    except (yaml.YAMLError, KeyError, TypeError) as error:
        raise BadInput(f"{path} is not a dbt sources file this command can read: {error}") from None


def table_yaml(source: str, table: str) -> str:
    return (
        f"      - name: {table}\n"
        f"        identifier: {source}_{table}\n"
        "        columns:\n"
        "          - name: id\n"
        "            data_tests: [unique, not_null]\n"
    )


def sources_yaml(source: str, table: str) -> str:
    return (
        "version: 2\n"
        "\n"
        "# Source name + table name must match the ingestion Source's `name` + `table`.\n"
        "sources:\n"
        f"  - name: {source}\n"
        "    schema: \"{{ env_var('RAW_SCHEMA', 'raw') }}\"\n"
        "    tables:\n" + table_yaml(source, table)
    )


def staging_model(source: str, table: str) -> str:
    return f"select\n    id,\n    data,\n    _loaded_at\nfrom {{{{ source('{source}', '{table}') }}}}\n"


def replace_once(text: str, old: str, new: str, path: Path) -> str:
    if text.count(old) != 1:
        raise BadInput(f"{path} must contain {old} exactly once to rename it, found {text.count(old)}")
    return text.replace(old, new)


def plan(repo_root: Path, source: str, table: str, like: str) -> Plan:
    for value, label in ((source, "<source>"), (table, "<table>")):
        if not NAME.match(value):
            raise BadInput(f"{label} {value!r} must match {NAME.pattern}")
    sources_root = repo_root / "ingestion" / "sources"
    template = sources_root / like
    if "/" in like or like.startswith(".") or not template.is_dir():
        raise BadInput(f"no source package {like!r} in ingestion/sources/")

    entries = read_sources((repo_root / SOURCES_FILE).read_text())
    old = [entry for entry in entries if entry.package == like]
    if not old:
        raise BadInput(f"{like} is in no entry of {SOURCES_FILE}, so it is not a source to copy")
    old_source, old_table = old[0].name, old[0].table
    several_chains = bool(old[0].settings)
    if several_chains and table == old_table:
        raise BadInput(
            f"{like} already loads {table} on several chains; for {source}, add chains/{source}/ to it "
            "and run `pnpm generate-sources` in ingestion/"
        )
    if any((entry.name, entry.table) == (source, table) for entry in entries):
        raise BadInput(f"({source!r}, {table!r}) is already in {SOURCES_FILE}")
    if several_chains:
        # A package that loads several chains is named for what it loads, such as evm-uniswap-v3.
        prefix = like.removesuffix(f"-{old_table.replace('_', '-')}")
        if prefix == like:
            raise BadInput(f"{like} does not end with its table, {old_table}, so the new package cannot be named after it")
        package = sources_root / f"{prefix}-{table.replace('_', '-')}"
    else:
        package = sources_root / package_name(source, table)
    if package.exists():
        raise BadInput(f"{package.relative_to(repo_root)} already exists")

    source_ts = template / "src" / "source.ts"
    for needed in (source_ts, template / "package.json"):
        if not needed.is_file():
            raise BadInput(f"{needed.relative_to(repo_root)} is missing, so {like} cannot be copied")
    renamed = source_ts.read_text()
    chain = None
    if several_chains:
        # The source is named for its chain by forChain(chain), so only the table is renamed. The new
        # chain's folder starts as a copy of the template's, of the same chain when it has one.
        own = template / "chains" / source
        chain = (own if own.is_dir() else old[0].folder(repo_root), package / "chains" / source)
    else:
        renamed = replace_once(renamed, f'name: "{old_source}"', f'name: "{source}"', source_ts)
    renamed = replace_once(renamed, f'table: "{old_table}"', f'table: "{table}"', source_ts)
    package_json = json.loads((template / "package.json").read_text())
    package_json["name"] = f"@ingestion/{package.name}"

    staging = repo_root / "transformation" / "models" / "staging" / source
    model = staging / f"stg_{source}__{table}.sql"
    if model.exists():
        raise BadInput(f"{model.relative_to(repo_root)} already exists")
    sources_yml = staging / f"_{source}__sources.yml"
    if sources_yml.exists():
        current = sources_yml.read_text()
        if table in source_tables(current, source, sources_yml):
            raise BadInput(f"{sources_yml.relative_to(repo_root)} already has table {table!r}")
        yml = current + ("" if current.endswith("\n") else "\n") + table_yaml(source, table)
    else:
        yml = sources_yaml(source, table)
    if table not in source_tables(yml, source, sources_yml):
        raise BadInput(f"could not add {table!r} under {source!r} in {sources_yml.relative_to(repo_root)}")

    return Plan(
        template=template,
        package=package,
        files={
            package / "package.json": json.dumps(package_json, indent=2) + "\n",
            package / "src" / "source.ts": renamed,
            sources_yml: yml,
            model: staging_model(source, table),
        },
        chain=chain,
    )


def generate_sources(repo_root: Path) -> str | None:
    """Regenerates sources.json from every package's export. Returns why it could not, when it could not."""
    for command in GENERATE:
        try:
            result = subprocess.run(command, cwd=repo_root / "ingestion", capture_output=True, text=True)
        except FileNotFoundError:
            return f"{command[0]} is not installed"
        if result.returncode != 0:
            output = (result.stdout + result.stderr).strip()
            return f"`{' '.join(command)}` in ingestion/ exited with code {result.returncode}" + (f":\n{output}" if output else "")
    return None


def run(repo_root: Path, source: str, table: str, like: str) -> int:
    planned = plan(repo_root, source, table, like)
    existed = {path for path in planned.files if path.exists()}
    # A SQLite file is a source's local state, such as the pools Pipes' factory pattern found.
    local = ("node_modules", ".env", "*.sqlite*")
    shutil.copytree(planned.template, planned.package, ignore=shutil.ignore_patterns(*local, "chains"))
    if planned.chain:
        shutil.copytree(*planned.chain, ignore=shutil.ignore_patterns(*local))
    for path, text in planned.files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    package = planned.package.relative_to(repo_root)
    inputs = (planned.chain[1] if planned.chain else planned.package).relative_to(repo_root)
    # The template had no folder for this chain, so the new one holds another chain's settings.
    borrowed = planned.chain and planned.chain[0].name != source
    model = f"transformation/models/staging/{source}/stg_{source}__{table}.sql"
    print(f"created {package}/ (a copy of {like})")
    if borrowed:
        print(f"created {inputs}/ (a copy of {planned.chain[0].relative_to(repo_root)}/)")
    for path in planned.files:
        print(f"{'changed' if path in existed else 'created'} {path.relative_to(repo_root)}")

    failure = generate_sources(repo_root)
    if failure:
        print(
            f"{failure}\nThe files above are written. Fix the error, then run `pnpm install` and "
            f"`pnpm generate-sources` in ingestion/ to add ({source!r}, {table!r}) to {SOURCES_FILE}.",
            file=sys.stderr,
        )
        return 1
    print("ran `pnpm install` in ingestion/, which links the new package and updates pnpm-lock.yaml")
    print(f"changed {SOURCES_FILE}")
    print(
        "\nNext steps:\n"
        f"1. Edit the copied code in {package}/src/ and {inputs}/addresses.json to read the new data.\n"
        + (f"   Set {inputs}/.env.example for {source}: it holds another chain's settings.\n" if borrowed else "")
        + f"2. Shape {model}: turn `data` into the columns you need.\n"
        "3. By hand, read the new source from a mart in transformation/models/marts/<pipeline>/: follow "
        "`## Adding a chain` in transformation/README.md. bj new-source does not touch marts.\n"
        "4. By hand, make sure a scheduled pipeline builds that mart: PIPELINES in orchestration/pipeline/schedules.py."
        " Until one does, the orchestration tests fail, because the new asset belongs to no scheduled pipeline."
    )
    return 0
