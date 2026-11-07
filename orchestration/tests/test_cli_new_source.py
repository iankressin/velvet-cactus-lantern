import json
import re
import shutil
import subprocess

import pytest
import yaml

from pipeline.assets.ingestion import ENTRIES, SOURCES, package_dir
from pipeline.cli import REPO_ROOT, BadInput
from pipeline.cli import new_source
from pipeline.cli.new_source import GENERATE, package_name, run
from pipeline.sources import SOURCES_FILE, read_sources

# A package that loads one chain. evm-* packages load several; see the chain tests below.
TEMPLATE = "arbitrum-token-bridge"


def fake_generator(root):
    """What `pnpm generate-sources` does, for the packages this repo has: every package's exported name and
    table, or its table on each chain in chains/, sorted. The repo copy holds only the packages a test
    copies, so the entries already in the file stay."""
    entries = {(e["name"], e["table"]): e for e in json.loads((root / SOURCES_FILE).read_text())}
    for source_ts in root.glob("ingestion/sources/*/src/source.ts"):
        text, package = source_ts.read_text(), source_ts.parents[1]
        table = re.search(r'table: "(\w+)"', text).group(1)
        if (package / "chains").is_dir():
            for chain in sorted(p.name for p in (package / "chains").iterdir() if p.is_dir()):
                entries[(chain, table)] = {"name": chain, "table": table, "package": package.name, "settings": f"chains/{chain}"}
        else:
            name = re.search(r'name: "(\w+)"', text).group(1)
            entries[(name, table)] = {"name": name, "table": table, "package": package.name}
    listed = [entry for _, entry in sorted(entries.items())]
    (root / SOURCES_FILE).write_text(json.dumps(listed, indent=2) + "\n")


@pytest.fixture
def pnpm(tmp_path, monkeypatch):
    """pnpm as a fake: records each command, and writes sources.json the way the generator would."""
    commands = []

    def fake_run(command, cwd, **kwargs):
        commands.append((command, cwd))
        if command == GENERATE[-1]:
            fake_generator(tmp_path)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(new_source.subprocess, "run", fake_run)
    return commands


@pytest.fixture
def repo(tmp_path, pnpm):
    """The files new-source reads, copied from the real repository, with local-only files in the template."""
    template = tmp_path / "ingestion" / "sources" / TEMPLATE
    shutil.copytree(REPO_ROOT / "ingestion" / "sources" / TEMPLATE, template, ignore=shutil.ignore_patterns("node_modules", ".env"))
    (template / "node_modules" / "viem").mkdir(parents=True)
    (template / ".env").write_text("EVM_RPC_URL=http://secret\n")
    (template / "factory.sqlite").write_bytes(b"pools of another source")
    shutil.copytree(REPO_ROOT / "transformation" / "models" / "staging", tmp_path / "transformation" / "models" / "staging")
    shutil.copy(REPO_ROOT / SOURCES_FILE, tmp_path / SOURCES_FILE)
    return tmp_path


def snapshot(root):
    return {path.relative_to(root): path.read_bytes() if path.is_file() else None for path in root.rglob("*")}


def sources_of(repo):
    return [(e.name, e.table) for e in read_sources((repo / SOURCES_FILE).read_text())]


def test_package_name_matches_the_dagster_asset_rule():
    """A package that loads several chains is named for what it loads; every other follows the rule."""
    for entry in ENTRIES:
        if not entry.settings:
            assert package_name(entry.name, entry.table) == package_dir(entry.name, entry.table).name


def test_adds_a_table_to_an_existing_source(repo, pnpm, capsys):
    yml_before = (repo / "transformation/models/staging/ethereum/_ethereum__sources.yml").read_text()

    assert run(repo, "ethereum", "erc721_holdings", TEMPLATE) == 0

    package = repo / "ingestion/sources/ethereum-erc721-holdings"
    assert not (package / "node_modules").exists()
    assert not (package / ".env").exists()
    assert not (package / "factory.sqlite").exists()
    assert (package / ".env.example").is_file()
    assert (package / "addresses.json").is_file()
    assert json.loads((package / "package.json").read_text())["name"] == "@ingestion/ethereum-erc721-holdings"
    source_ts = (package / "src/source.ts").read_text()
    assert 'name: "ethereum"' in source_ts
    assert 'table: "erc721_holdings"' in source_ts
    assert 'table: "token_bridge"' not in source_ts

    yml_path = repo / "transformation/models/staging/ethereum/_ethereum__sources.yml"
    yml = yml_path.read_text()
    assert yml.startswith(yml_before)
    (ethereum,) = yaml.safe_load(yml)["sources"]
    tables_before = [t["name"] for t in yaml.safe_load(yml_before)["sources"][0]["tables"]]
    assert [t["name"] for t in ethereum["tables"]] == [*tables_before, "erc721_holdings"]
    assert ethereum["tables"][-1] == {
        "name": "erc721_holdings",
        "identifier": "ethereum_erc721_holdings",
        "columns": [{"name": "id", "data_tests": ["unique", "not_null"]}],
    }

    model = (repo / "transformation/models/staging/ethereum/stg_ethereum__erc721_holdings.sql").read_text()
    assert "{{ source('ethereum', 'erc721_holdings') }}" in model
    assert all(column in model for column in ("id,", "data,", "_loaded_at"))

    # The generator ran in the workspace, after pnpm install linked the new package, and rewrote sources.json.
    assert pnpm == [(list(command), repo / "ingestion") for command in GENERATE]
    assert sources_of(repo) == sorted([*SOURCES, ("ethereum", "erc721_holdings")])
    entries = read_sources((repo / SOURCES_FILE).read_text())
    assert [e.package for e in entries if e.table == "erc721_holdings"] == ["ethereum-erc721-holdings"]

    out = capsys.readouterr().out
    assert "changed ingestion/sources.json" in out
    assert "changed transformation/models/staging/ethereum/_ethereum__sources.yml" in out
    assert "orchestration/pipeline/assets/ingestion.py" not in out
    assert "Adding a chain" in out and "PIPELINES" in out and "mart" in out


def test_creates_the_sources_file_of_a_new_source(repo):
    assert run(repo, "polygon", "token_bridge", TEMPLATE) == 0

    yml = (repo / "transformation/models/staging/polygon/_polygon__sources.yml").read_text()
    shape = (repo / "transformation/models/staging/ethereum/_ethereum__sources.yml").read_text()
    assert yml.splitlines()[:7] == shape.replace("ethereum", "polygon").splitlines()[:7]
    (polygon,) = yaml.safe_load(yml)["sources"]
    assert polygon["name"] == "polygon"
    assert polygon["schema"] == "{{ env_var('RAW_SCHEMA', 'raw') }}"
    assert polygon["tables"][0]["identifier"] == "polygon_token_bridge"
    assert (repo / "transformation/models/staging/polygon/stg_polygon__token_bridge.sql").is_file()
    source_ts = (repo / "ingestion/sources/polygon-token-bridge/src/source.ts").read_text()
    assert 'name: "polygon"' in source_ts and 'name: "arbitrum"' not in source_ts
    assert ("polygon", "token_bridge") in sources_of(repo)


def test_a_failed_generator_leaves_the_files_and_exits_1(repo, monkeypatch, capsys):
    def failing_run(command, cwd, **kwargs):
        return subprocess.CompletedProcess(command, 1, "", "ERR_PNPM_SOMETHING\n")

    monkeypatch.setattr(new_source.subprocess, "run", failing_run)
    before = sources_of(repo)

    assert run(repo, "ethereum", "erc721_holdings", TEMPLATE) == 1

    assert (repo / "ingestion/sources/ethereum-erc721-holdings/src/source.ts").is_file()
    assert sources_of(repo) == before
    out, err = capsys.readouterr()
    assert "created ingestion/sources/ethereum-erc721-holdings/" in out
    assert "changed ingestion/sources.json" not in out
    assert "`pnpm install` in ingestion/ exited with code 1" in err and "ERR_PNPM_SOMETHING" in err
    assert "('ethereum', 'erc721_holdings')" in err and "pnpm generate-sources" in err


def test_a_missing_pnpm_exits_1(repo, monkeypatch, capsys):
    def no_pnpm(command, cwd, **kwargs):
        raise FileNotFoundError(command[0])

    monkeypatch.setattr(new_source.subprocess, "run", no_pnpm)
    assert run(repo, "ethereum", "erc721_holdings", TEMPLATE) == 1
    assert "pnpm is not installed" in capsys.readouterr().err


def refuses_without_writing(repo, pnpm, *args, match):
    before = snapshot(repo)
    with pytest.raises(BadInput, match=match):
        run(repo, *args)
    assert snapshot(repo) == before
    assert pnpm == []


def test_refuses_a_template_missing_from_sources(repo, pnpm):
    shutil.copytree(repo / "ingestion/sources" / TEMPLATE, repo / "ingestion/sources/scratch")
    refuses_without_writing(repo, pnpm, "ethereum", "nft_balances", "scratch", match="in no entry of ingestion/sources.json")


def copy_package(repo, package):
    """A package that loads several chains, copied from the real repository into the repo copy."""
    template = repo / "ingestion/sources" / package
    shutil.copytree(REPO_ROOT / "ingestion/sources" / package, template, ignore=shutil.ignore_patterns("node_modules", ".env"))
    return template


def test_copies_a_package_that_loads_several_chains_with_only_the_new_chain(repo, pnpm, capsys):
    template = copy_package(repo, "evm-eth-balances")
    shutil.copytree(template / "chains/ethereum", template / "chains/base")
    (template / "chains/ethereum/.env").write_text("EVM_RPC_URL=http://secret\n")
    (template / "chains/ethereum/factory.sqlite").write_bytes(b"pools of another source")

    assert run(repo, "ethereum", "erc721_holdings", "evm-eth-balances") == 0

    package = repo / "ingestion/sources/evm-erc721-holdings"
    assert [p.name for p in (package / "chains").iterdir()] == ["ethereum"]
    assert sorted(p.name for p in (package / "chains/ethereum").iterdir()) == [".env.example", "addresses.json"]
    assert (package / ".env.example").is_file()
    assert not (package / "node_modules").exists()
    assert json.loads((package / "package.json").read_text())["name"] == "@ingestion/evm-erc721-holdings"
    source_ts = (package / "src/source.ts").read_text()
    assert 'table: "erc721_holdings"' in source_ts and 'table: "eth_balances"' not in source_ts
    entries = read_sources((repo / SOURCES_FILE).read_text())
    assert [(e.name, e.package, e.settings) for e in entries if e.table == "erc721_holdings"] == [
        ("ethereum", "evm-erc721-holdings", "chains/ethereum")
    ]
    assert (repo / "transformation/models/staging/ethereum/stg_ethereum__erc721_holdings.sql").is_file()
    out = capsys.readouterr().out
    assert "ingestion/sources/evm-erc721-holdings/chains/ethereum/addresses.json to read the new data" in out
    assert "another chain's settings" not in out


def test_a_chain_the_template_lacks_starts_as_a_copy_of_another(repo, pnpm, capsys):
    template = copy_package(repo, "evm-eth-balances")

    assert run(repo, "polygon", "erc721_holdings", "evm-eth-balances") == 0

    chain = repo / "ingestion/sources/evm-erc721-holdings/chains/polygon"
    for name in (".env.example", "addresses.json"):
        assert (chain / name).read_text() == (template / "chains/ethereum" / name).read_text()
    assert ("polygon", "erc721_holdings") in sources_of(repo)
    out = capsys.readouterr().out
    assert (
        "created ingestion/sources/evm-erc721-holdings/chains/polygon/ "
        "(a copy of ingestion/sources/evm-eth-balances/chains/ethereum/)"
    ) in out
    assert "Set ingestion/sources/evm-erc721-holdings/chains/polygon/.env.example for polygon" in out


def test_copies_the_erc20_transfers_stream_source_under_the_new_table(repo):
    copy_package(repo, "evm-erc20-transfers")

    assert run(repo, "ethereum", "erc20_approvals", "evm-erc20-transfers") == 0

    package = repo / "ingestion/sources/evm-erc20-approvals"
    assert [p.name for p in (package / "chains").iterdir()] == ["ethereum"]
    source_ts = (package / "src/source.ts").read_text()
    assert 'table: "erc20_approvals"' in source_ts and 'table: "erc20_transfers"' not in source_ts
    # The stream id labels the run's logs and metrics, so it must not still name the template's table.
    assert "erc20-transfers" not in source_ts
    entries = read_sources((repo / SOURCES_FILE).read_text())
    assert [(e.name, e.package) for e in entries if e.table == "erc20_approvals"] == [("ethereum", "evm-erc20-approvals")]


def test_refuses_a_new_chain_of_the_table_a_package_already_loads(repo, pnpm):
    copy_package(repo, "evm-erc20-transfers")
    refuses_without_writing(repo, pnpm, "polygon", "erc20_transfers", "evm-erc20-transfers", match="add chains/polygon/ to it")


def test_refuses_a_template_that_does_not_exist(repo, pnpm):
    refuses_without_writing(repo, pnpm, "ethereum", "nft_balances", "ethereum-nft-balances", match="no source package")


def test_refuses_a_package_that_exists(repo, pnpm):
    (repo / "ingestion/sources/ethereum-nft-balances").mkdir()
    refuses_without_writing(repo, pnpm, "ethereum", "nft_balances", TEMPLATE, match="already exists")


def test_refuses_a_pair_already_in_sources(repo, pnpm):
    refuses_without_writing(repo, pnpm, "ethereum", "erc20_balances", TEMPLATE, match="already in ingestion/sources.json")


def test_refuses_a_source_ts_it_cannot_rename_exactly_once(repo, pnpm):
    source_ts = repo / "ingestion/sources" / TEMPLATE / "src/source.ts"
    source_ts.write_text(source_ts.read_text() + '\n// table: "token_bridge"\n')
    refuses_without_writing(repo, pnpm, "ethereum", "nft_balances", TEMPLATE, match="exactly once")


def test_refuses_a_table_the_sources_file_already_has(repo, pnpm):
    yml = repo / "transformation/models/staging/ethereum/_ethereum__sources.yml"
    yml.write_text(yml.read_text() + "      - name: nft_balances\n        identifier: ethereum_nft_balances\n")
    refuses_without_writing(repo, pnpm, "ethereum", "nft_balances", TEMPLATE, match="already has table")


def test_refuses_a_sources_file_where_the_table_would_land_under_another_source(repo, pnpm):
    yml = repo / "transformation/models/staging/ethereum/_ethereum__sources.yml"
    yml.write_text(yml.read_text() + "  - name: legacy\n    tables:\n      - name: old\n")
    refuses_without_writing(repo, pnpm, "ethereum", "nft_balances", TEMPLATE, match="could not add")


@pytest.mark.parametrize("source, table", [("Ethereum", "x"), ("ethereum", "nft-balances"), ("1chain", "x")])
def test_refuses_names_that_are_not_identifiers(repo, pnpm, source, table):
    refuses_without_writing(repo, pnpm, source, table, TEMPLATE, match="must match")
