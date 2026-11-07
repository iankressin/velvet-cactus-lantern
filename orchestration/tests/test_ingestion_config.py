import os
import subprocess
from collections import Counter

import dagster as dg
import pytest
import yaml
from dagster._core.snap.snap_to_yaml import default_values_yaml_from_type_snap
from dagster._serdes import serialize_value
from dotenv import dotenv_values

from pipeline.assets import ingestion
from pipeline.assets.ingestion import ENTRIES, SECRET_SHOWN, env_settings, ingestion_definitions
from pipeline.project import INGESTION_DIR, REPO_ROOT
from pipeline.sources import SourceEntry

ETH_BALANCES = dg.AssetKey(["ethereum", "eth_balances"])
BTC_BALANCES = dg.AssetKey(["bitcoin", "btc_balances"])


def example_keys(entry: SourceEntry) -> set[str]:
    files = [INGESTION_DIR / "sources" / entry.package / ".env.example"]
    if entry.settings:
        files.append(entry.folder(REPO_ROOT) / ".env.example")
    return {key for file in files for key in dotenv_values(file)}


def asset_job(assets: list[dg.AssetsDefinition], resource: dg.ResourceDefinition) -> dg.JobDefinition:
    return dg.Definitions(assets=assets, resources={"ingestion_env": resource}).resolve_implicit_global_asset_job_def()


def scaffold(assets: list[dg.AssetsDefinition], resource: dg.ResourceDefinition) -> dict:
    snapshot = asset_job(assets, resource).get_job_snapshot()
    schema = snapshot.config_schema_snapshot
    root = schema.get_config_snap(snapshot.mode_def_snaps[0].root_config_key)
    return yaml.safe_load(default_values_yaml_from_type_snap(schema, root))


def shared_field(resource: dg.ResourceDefinition, key: str) -> dg.Field:
    return resource.config_schema.config_type.fields[key]


def test_scaffold_puts_keys_two_sources_read_in_the_resource_and_the_rest_on_their_asset():
    counts = Counter(key for entry in ENTRIES for key in example_keys(entry))
    shared = {key for key, count in counts.items() if count > 1}
    assets, _, resource = ingestion_definitions({})
    config = scaffold(assets, resource)

    assert set(config["resources"]["ingestion_env"]["config"]) == shared
    for entry in ENTRIES:
        own = example_keys(entry) - shared
        op = config.get("ops", {}).get(f"{entry.name}__{entry.table}")
        assert (set(op["config"]) if op else set()) == own


def test_each_field_shows_the_value_its_source_reads():
    assets, _, resource = ingestion_definitions({"LOG_LEVEL": "warn", "DSHACKLE_URL": "http://dshackle"})
    config = scaffold(assets, resource)
    assert config["resources"]["ingestion_env"]["config"]["LOG_LEVEL"] == "warn"
    assert config["ops"]["bitcoin__btc_balances"]["config"]["DSHACKLE_URL"] == "http://dshackle"


def test_effective_values_follow_load_env_order(tmp_path, monkeypatch):
    package = tmp_path / "ingestion" / "sources" / "pkg"
    chain = package / "chains" / "x"
    chain.mkdir(parents=True)
    (package / ".env.example").write_text("A=\nB=\nC=\nD=\nE=\n")
    (package / ".env").write_text("A=pkg\nB=pkg\nC=pkg\nD=pkg\n")
    (chain / ".env.example").write_text("A=example\nB=example\nC=example\n")
    (chain / ".env").write_text("A=chain\nB=chain\n")
    monkeypatch.setattr(ingestion, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(ingestion, "INGESTION_DIR", tmp_path / "ingestion")
    entry = SourceEntry(name="x", table="t", package="pkg", settings="chains/x")

    values = ingestion.effective_env(entry, {"A": "env", "E": ""})
    assert values == {"A": "env", "B": "chain", "C": "example", "D": "pkg", "E": ""}


def test_a_key_in_both_files_takes_the_chain_setting():
    metadata = next(entry for entry in ENTRIES if (entry.name, entry.table) == ("ethereum", "erc20_metadata"))
    assert "RPC_BATCH_SIZE" in dotenv_values(INGESTION_DIR / "sources" / metadata.package / ".env.example")
    assert env_settings(metadata)["RPC_BATCH_SIZE"].repo_path.as_posix().endswith("chains/ethereum/.env.example")


def test_a_shared_key_its_sources_disagree_on_shows_empty_and_names_each_value(monkeypatch):
    read = ingestion.effective_env

    def disagreeing(entry, environ):
        values = read(entry, environ)
        if "BLOCK_NUMBER" in values:
            values["BLOCK_NUMBER"] = "latest" if entry.table == "erc20_metadata" else "finalized"
        return values

    monkeypatch.setattr(ingestion, "effective_env", disagreeing)
    field = shared_field(ingestion_definitions({})[2], "BLOCK_NUMBER")
    assert field.default_value == ""
    assert "ethereum.erc20_metadata=latest" in field.description
    assert "ethereum.eth_balances=finalized" in field.description


def test_a_secret_shows_masked_and_never_reaches_the_job_snapshot():
    assets, _, resource = ingestion_definitions({"WAREHOUSE_PASSWORD": "s3cret-pw-77"})
    assert scaffold(assets, resource)["resources"]["ingestion_env"]["config"]["WAREHOUSE_PASSWORD"] == SECRET_SHOWN
    assert "s3cret-pw-77" not in serialize_value(asset_job(assets, resource).get_job_snapshot())


@pytest.fixture
def pnpm_calls(monkeypatch) -> list[dict]:
    calls = []

    def fake_run(args, **kwargs):
        calls.append(kwargs)
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(ingestion.subprocess, "run", fake_run)
    return calls


def overridden_keys(call: dict) -> set[str]:
    return {key for key, value in call["env"].items() if value != os.environ.get(key)} - {"DAGSTER_RUN_ID", "CHAIN"}


def test_a_run_overrides_only_what_it_changed_and_only_for_sources_that_read_it(monkeypatch, pnpm_calls):
    monkeypatch.setenv("LOG_LEVEL", "info")
    monkeypatch.setenv("EVM_RPC_URL", "http://shown")
    assets, _, resource = ingestion_definitions()
    picked = [asset for asset in assets if asset.key in (ETH_BALANCES, BTC_BALANCES)]
    config = scaffold(picked, resource)

    dg.materialize(picked, resources={"ingestion_env": resource}, run_config=config)
    assert [overridden_keys(call) for call in pnpm_calls] == [set(), set()]

    pnpm_calls.clear()
    config["resources"]["ingestion_env"]["config"].update(EVM_RPC_URL="http://changed", LOG_LEVEL="debug")
    instance = dg.DagsterInstance.ephemeral()
    result = dg.materialize(picked, resources={"ingestion_env": resource}, run_config=config, instance=instance)
    by_chain = {call["env"]["CHAIN"]: call["env"] for call in pnpm_calls}
    assert (by_chain["ethereum"]["EVM_RPC_URL"], by_chain["ethereum"]["LOG_LEVEL"]) == ("http://changed", "debug")
    assert (by_chain["bitcoin"]["EVM_RPC_URL"], by_chain["bitcoin"]["LOG_LEVEL"]) == ("http://shown", "debug")

    messages = [entry.user_message for entry in instance.all_logs(result.run_id)]
    assert any("EVM_RPC_URL" in message for message in messages)
    assert not any("http://changed" in message for message in messages)


def test_a_mapping_value_fails_the_run_and_names_its_key(pnpm_calls):
    assets, _, resource = ingestion_definitions({})
    eth = [asset for asset in assets if asset.key == ETH_BALANCES]
    run_config = {"resources": {"ingestion_env": {"config": {"LOG_LEVEL": {"a": 1}}}}}
    with pytest.raises(dg.Failure, match="LOG_LEVEL"):
        dg.materialize(eth, resources={"ingestion_env": resource}, run_config=run_config)
    assert pnpm_calls == []


def test_the_dead_letter_check_reads_the_schema_the_run_wrote_to(monkeypatch, pnpm_calls):
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    assets, checks, resource = ingestion_definitions()
    eth = [asset for asset in assets if asset.key == ETH_BALANCES]
    eth_check = [check for check in checks if ETH_BALANCES in {key.asset_key for key in check.check_keys}]
    schemas = []
    monkeypatch.setattr(ingestion, "count_dead_letters", lambda table, env: schemas.append(env["RAW_SCHEMA"]) or (0, 0))
    config = scaffold(eth, resource)

    dg.materialize([*eth, *eth_check], resources={"ingestion_env": resource}, run_config=config)
    config["resources"]["ingestion_env"]["config"]["RAW_SCHEMA"] = "scratch"
    dg.materialize([*eth, *eth_check], resources={"ingestion_env": resource}, run_config=config)
    assert schemas == ["raw", "scratch"]
