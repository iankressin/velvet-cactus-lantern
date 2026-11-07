import json
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import pytest

from pipeline.cli import REQUIRED_ENV, main
from pipeline.cli import install
from pipeline.sources import SOURCES_FILE

ROOT_EXAMPLE = """\
WAREHOUSE_HOST=localhost
WAREHOUSE_PORT=5432
WAREHOUSE_USER=elt
WAREHOUSE_PASSWORD=elt
WAREHOUSE_DB=warehouse
RAW_SCHEMA=raw
"""
PACKAGE_EXAMPLE = "WAREHOUSE_HOST=localhost\nBLOCK_NUMBER=finalized\n"
PACKAGES = ("ethereum-eth-balances", "ethereum-erc20-transfers")
VERSIONS = {"node": "v24.11.0", "pnpm": "10.17.0", "uv": "uv 0.9.5"}
PNPM = "pnpm install --frozen-lockfile"
NEXT = "uv run --project orchestration bj dev"


def make_repo(root: Path) -> None:
    """The files install and dev read: the .env.example files, sources.json and mise.toml. No .env."""
    (root / ".env.example").write_text(ROOT_EXAMPLE)
    (root / "mise.toml").write_text('[tools]\nnode = "24"\npnpm = "10.17.0"\n')
    for package in PACKAGES:
        folder = root / "ingestion" / "sources" / package
        folder.mkdir(parents=True)
        (folder / ".env.example").write_text(PACKAGE_EXAMPLE)
    entries = [{"name": "ethereum", "table": p.removeprefix("ethereum-").replace("-", "_"), "package": p} for p in PACKAGES]
    (root / SOURCES_FILE).write_text(json.dumps(entries))
    (root / "transformation").mkdir()
    (root / "orchestration").mkdir()


class Tools:
    """Fakes for pnpm, docker and dbt parse, which land in `ran` in order, and for bj doctor's `--version` calls."""

    def __init__(self, monkeypatch):
        self.ran: list[tuple[str, Path]] = []
        self.missing: set[str] = set()
        self.failing: dict[str, tuple[int, str]] = {}
        self.env_at_parse: dict[str, str] = {}
        monkeypatch.setattr(subprocess, "run", self.run)
        monkeypatch.setattr(install, "parse_project", self.parse)

    def run(self, command, cwd=None, capture_output=False, text=False):
        if command[0] in self.missing:
            raise FileNotFoundError(command[0])
        if command[-1] == "--version":
            return subprocess.CompletedProcess(command, 0, VERSIONS[command[0]] + "\n", "")
        shown = " ".join(command)
        self.ran.append((shown, cwd))
        code, output = self.failing.get(shown, (0, ""))
        return subprocess.CompletedProcess(command, code, "", output)

    def parse(self, project):
        self.ran.append(("dbt parse", project))
        self.env_at_parse = dict(os.environ)


@contextmanager
def without_root_settings():
    """os.environ as a shell that never sourced .env has it, put back afterwards, since install loads .env."""
    with mock.patch.dict(os.environ):
        for key in REQUIRED_ENV:
            os.environ.pop(key, None)
        yield


@pytest.fixture
def repo(tmp_path, monkeypatch):
    make_repo(tmp_path)
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    with without_root_settings():
        yield tmp_path


@pytest.fixture
def tools(monkeypatch):
    return Tools(monkeypatch)


def package_env(repo, package):
    return repo / "ingestion" / "sources" / package / ".env"


def test_copies_the_root_env_and_loads_it_for_dbt(repo, tools, capsys):
    assert main(["install"]) == 0
    assert (repo / ".env").read_text() == ROOT_EXAMPLE
    assert "copied .env.example to .env" in capsys.readouterr().out
    assert tools.env_at_parse["WAREHOUSE_DB"] == "warehouse"


def test_leaves_an_existing_root_env_byte_for_byte(repo, tools, capsys):
    kept = b"# mine\nWAREHOUSE_HOST=db.example\nWAREHOUSE_PORT=6543\nWAREHOUSE_USER=me\nWAREHOUSE_PASSWORD=pw-41\nWAREHOUSE_DB=w\nRAW_SCHEMA=r"
    (repo / ".env").write_bytes(kept)

    assert main(["install"]) == 0

    assert (repo / ".env").read_bytes() == kept
    assert "copied .env.example to .env" not in capsys.readouterr().out
    assert tools.env_at_parse["WAREHOUSE_PASSWORD"] == "pw-41"


def test_copies_a_missing_package_env_and_keeps_an_existing_one(repo, tools, capsys):
    kept, copied = (package_env(repo, package) for package in PACKAGES)
    kept.write_text("WAREHOUSE_HOST=db.example\nBLOCK_NUMBER=latest\n")

    assert main(["install"]) == 0

    assert copied.read_text() == PACKAGE_EXAMPLE
    assert kept.read_text() == "WAREHOUSE_HOST=db.example\nBLOCK_NUMBER=latest\n"
    out = capsys.readouterr().out
    assert f"PASS  ingestion/sources/{PACKAGES[1]}/.env copied from .env.example" in out
    assert f"PASS  ingestion/sources/{PACKAGES[0]}/.env sets every required key" in out


def test_an_env_lacking_a_required_key_stops_before_pnpm(repo, tools, capsys):
    package_env(repo, PACKAGES[0]).write_text("WAREHOUSE_HOST=db.example\n")

    assert main(["install"]) == 1

    assert f"FAIL  ingestion/sources/{PACKAGES[0]}/.env lacks BLOCK_NUMBER" in capsys.readouterr().out
    assert tools.ran == []


def test_runs_pnpm_install_frozen_in_ingestion_then_dbt_parse(repo, tools, capsys):
    assert main(["install"]) == 0
    assert tools.ran == [(PNPM, repo / "ingestion"), ("dbt parse", repo / "transformation")]
    assert capsys.readouterr().out.splitlines()[-1].strip() == NEXT


def test_missing_pnpm_exits_2_naming_pnpm(repo, tools, capsys):
    tools.missing = {"pnpm"}

    assert main(["install"]) == 2

    err = capsys.readouterr().err
    assert "pnpm is not on PATH" in err and "mise.toml" in err
    assert err.count("\n") == 1
    assert tools.ran == []


def test_failing_pnpm_exits_1_with_its_output_and_skips_dbt_parse(repo, tools, capsys):
    tools.failing[PNPM] = (1, "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n")

    assert main(["install"]) == 1

    out = capsys.readouterr().out
    assert f"`{PNPM}` exited with code 1:\nERR_PNPM_OUTDATED_LOCKFILE" in out
    assert NEXT not in out
    assert tools.ran == [(PNPM, repo / "ingestion")]


def test_a_second_run_copies_nothing_and_succeeds(repo, tools, capsys):
    assert main(["install"]) == 0
    capsys.readouterr()
    edited = {repo / ".env": ROOT_EXAMPLE.replace("=elt", "=edited"), package_env(repo, PACKAGES[0]): "BLOCK_NUMBER=latest\nWAREHOUSE_HOST=h\n"}
    for path, text in edited.items():
        path.write_text(text)

    assert main(["install"]) == 0

    assert "copied" not in capsys.readouterr().out
    assert {path: path.read_text() for path in edited} == edited
    assert package_env(repo, PACKAGES[1]).read_text() == PACKAGE_EXAMPLE
