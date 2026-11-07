"""bj coverage: the blocks each stream source has loaded, from its START_BLOCK to the cursor Pipes keeps.

Pipes resumes a stream after its cursor and never reads a block twice, so a stream source holds every
block from START_BLOCK to the cursor, for the wallets and tokens in its addresses.json. Changing either
means resetting the cursor, so coverage reads both as they are now.
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg2
from dotenv import dotenv_values

from pipeline.cli import BadInput, require_env
from pipeline.sources import SOURCES_FILE, read_sources
from pipeline.warehouse import read_cursor


@dataclass(frozen=True)
class Coverage:
    source: str
    table: str
    raw_table: str
    start_block: int
    start_block_file: str
    cursor: int | None
    filter: dict[str, list[str]]

    @property
    def name(self) -> str:
        return f"{self.source}.{self.table}"

    @property
    def covered(self) -> tuple[int, int] | None:
        return (self.start_block, self.cursor) if self.cursor is not None else None

    def gaps(self, blocks: tuple[int, int], wanted: dict[str, list[str]]) -> list[str]:
        """What the loaded data lacks for these blocks and this subset of addresses.json. Empty when it has it all."""
        first, last = blocks
        gaps = []
        if self.start_block > first:
            gaps.append(f"START_BLOCK {self.start_block} is after {first}")
        if self.cursor is None:
            gaps.append("no run has saved a cursor")
        elif self.cursor < last:
            gaps.append(f"cursor {self.cursor} is before {last}")
        for key, values in wanted.items():
            if key not in self.filter:
                gaps.append(f"addresses.json has no {key!r}")
                continue
            loaded = {value.lower() for value in self.filter[key]}
            missing = [value for value in values if value.lower() not in loaded]
            if missing:
                gaps.append(f"{key} not in addresses.json: {', '.join(missing)}")
        return gaps

    def to_json(self) -> dict[str, Any]:
        return {
            "source": self.name,
            "raw_table": self.raw_table,
            "start_block": self.start_block,
            "start_block_file": self.start_block_file,
            "cursor": self.cursor,
            "filter": self.filter,
            "covered": list(self.covered) if self.covered else None,
        }


def folders(repo_root: Path) -> dict[str, Path]:
    """Every source in sources.json, as <source>.<table>, with the folder of its .env.example and
    addresses.json: its package, or the chain's folder in a package that loads several chains."""
    return {
        f"{entry.name}.{entry.table}": entry.folder(repo_root)
        for entry in read_sources((repo_root / SOURCES_FILE).read_text())
    }


def sources(repo_root: Path) -> list[str]:
    """Every source in sources.json, as <source>.<table>."""
    return list(folders(repo_root))


def stream_sources(repo_root: Path) -> list[str]:
    """The sources that are stream sources: those whose .env.example sets START_BLOCK.
    A stream source needs a first block; a call source reads at one block, or at the tip."""
    return [
        name
        for name, folder in folders(repo_root).items()
        if dotenv_values(folder / ".env.example").get("START_BLOCK")
    ]


def start_block(repo_root: Path, folder: Path) -> tuple[int, str]:
    """START_BLOCK as a run reads it, and the file it came from: the folder's .env, else .env.example."""
    for name in (".env", ".env.example"):
        value = dotenv_values(folder / name).get("START_BLOCK")
        if value:
            path = (folder / name).relative_to(repo_root)
            if not value.isdigit():
                raise BadInput(f"START_BLOCK in {path} must be a block number, not {value!r}")
            return int(value), str(path)
    raise BadInput(f"{folder.relative_to(repo_root)} sets no START_BLOCK in .env or .env.example")


def address_filter(repo_root: Path, folder: Path) -> dict[str, list[str]]:
    path = folder / "addresses.json"
    label = path.relative_to(repo_root)
    try:
        addresses = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise BadInput(f"could not read {label}: {error}") from None
    if not isinstance(addresses, dict) or not all(
        isinstance(values, list) and all(isinstance(value, str) for value in values) for values in addresses.values()
    ):
        raise BadInput(f"{label} must map each key to a list of addresses")
    return addresses


def read(repo_root: Path, name: str) -> Coverage:
    source, table = name.split(".")
    folder = folders(repo_root)[name]
    block, block_file = start_block(repo_root, folder)
    schema = os.environ["RAW_SCHEMA"]
    try:
        cursor = read_cursor(f"{source}_{table}")
    except psycopg2.Error as error:
        raise BadInput(f"could not read the cursor in {schema}._sync: {' '.join(str(error).split())}") from None
    return Coverage(source, table, f"{schema}.{source}_{table}", block, block_file, cursor, address_filter(repo_root, folder))


def run(repo_root: Path, name: str | None) -> int:
    streams = stream_sources(repo_root)
    if name is not None and name not in streams:
        raise BadInput(f"{name!r} is not a stream source; stream sources: {', '.join(streams) or 'none'}")
    require_env()
    coverages = [read(repo_root, stream).to_json() for stream in ([name] if name else streams)]
    print(json.dumps(coverages[0] if name else coverages, indent=2))
    return 0
