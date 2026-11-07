import subprocess

import dagster as dg
import pytest
import yaml
from dagster._config.snap import ConfigSchemaSnapshot, ConfigTypeSnap
from dagster._core.snap.snap_to_yaml import default_values_yaml_from_type_snap
from dotenv import dotenv_values

from pipeline.assets import ingestion
from pipeline.assets.ingestion import ENTRIES, check_env, ingestion_assets
from pipeline.definitions import defs
from pipeline.project import INGESTION_DIR, REPO_ROOT

ETH_BALANCES = dg.AssetKey(["ethereum", "eth_balances"])
ERC20_METADATA = dg.AssetKey(["ethereum", "erc20_metadata"])


def asset_def(key: dg.AssetKey) -> dg.AssetsDefinition:
    return next(asset for asset in ingestion_assets if asset.key == key)


def launchpad_schema(key: dg.AssetKey) -> tuple[ConfigSchemaSnapshot, ConfigTypeSnap]:
    job = defs.resolve_implicit_global_asset_job_def().get_subset(asset_selection={key})
    snapshot = job.get_job_snapshot()
    schema = snapshot.config_schema_snapshot
    return schema, schema.get_config_snap(snapshot.mode_def_snaps[0].root_config_key)


def scaffolded_config(key: dg.AssetKey) -> dict:
    schema, root = launchpad_schema(key)
    return yaml.safe_load(default_values_yaml_from_type_snap(schema, root))["ops"][asset_def(key).op.name]["config"]


def config_fields(key: dg.AssetKey) -> dict:
    schema, root = launchpad_schema(key)
    ops = schema.get_config_snap(root.get_field("ops").type_key)
    op = schema.get_config_snap(ops.get_field(asset_def(key).op.name).type_key)
    config = schema.get_config_snap(op.get_field("config").type_key)
    return {field.name: field for field in config.fields}


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda entry: f"{entry.name}.{entry.table}")
def test_scaffold_lists_every_key_of_the_env_examples_empty(entry):
    files = [INGESTION_DIR / "sources" / entry.package / ".env.example"]
    if entry.settings:
        files.append(entry.folder(REPO_ROOT) / ".env.example")
    keys = {key for file in files for key in dotenv_values(file)}
    assert keys
    assert scaffolded_config(dg.AssetKey([entry.name, entry.table])) == dict.fromkeys(keys, "")


def test_chain_settings_come_from_the_chain_folder():
    eth = config_fields(ETH_BALANCES)
    assert {"EVM_RPC_URL", "RPC_BATCH_SIZE"} <= eth.keys()
    assert "chains/ethereum/.env.example" in eth["EVM_RPC_URL"].description

    sol = config_fields(dg.AssetKey(["solana", "sol_balances"]))
    assert "SOLANA_RPC_URL" in sol
    assert "EVM_RPC_URL" not in sol


def test_a_key_in_both_files_takes_the_chain_setting():
    package = INGESTION_DIR / "sources" / "evm-erc20-metadata"
    assert "RPC_BATCH_SIZE" in dotenv_values(package / ".env.example")
    assert "RPC_BATCH_SIZE" in dotenv_values(package / "chains" / "ethereum" / ".env.example")
    assert "chains/ethereum/.env.example" in config_fields(ERC20_METADATA)["RPC_BATCH_SIZE"].description


@pytest.fixture
def pnpm_calls(monkeypatch) -> list[dict]:
    calls = []

    def fake_run(args, **kwargs):
        calls.append(kwargs)
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(ingestion.subprocess, "run", fake_run)
    return calls


def child_env(calls: list[dict], keys: tuple[str, ...]) -> dict[str, str | None]:
    [call] = calls
    return {key: call["env"].get(key) for key in keys}


def test_run_config_overrides_the_environment_for_one_run(monkeypatch, pnpm_calls):
    keys = ("EVM_RPC_URL", "RPC_BATCH_SIZE", "LOG_LEVEL", "CHAIN")
    monkeypatch.setenv("EVM_RPC_URL", "from-env")
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    monkeypatch.delenv("RPC_BATCH_SIZE", raising=False)
    instance = dg.DagsterInstance.ephemeral()
    config = {"EVM_RPC_URL": "http://override", "RPC_BATCH_SIZE": 10, "LOG_LEVEL": ""}
    result = dg.materialize(
        [asset_def(ETH_BALANCES)],
        run_config={"ops": {"ethereum__eth_balances": {"config": config}}},
        instance=instance,
    )
    assert child_env(pnpm_calls, keys) == {
        "EVM_RPC_URL": "http://override",
        "RPC_BATCH_SIZE": "10",
        "LOG_LEVEL": None,
        "CHAIN": "ethereum",
    }
    messages = [entry.user_message for entry in instance.all_logs(result.run_id)]
    assert any("EVM_RPC_URL" in message and "RPC_BATCH_SIZE" in message for message in messages)
    assert not any("http://override" in message for message in messages)

    pnpm_calls.clear()
    dg.materialize([asset_def(ETH_BALANCES)])
    assert child_env(pnpm_calls, keys) == {
        "EVM_RPC_URL": "from-env",
        "RPC_BATCH_SIZE": None,
        "LOG_LEVEL": None,
        "CHAIN": "ethereum",
    }


def test_a_mapping_value_fails_the_run_and_names_its_key(pnpm_calls):
    run_config = {"ops": {"ethereum__eth_balances": {"config": {"LOG_LEVEL": {"a": 1}}}}}
    with pytest.raises(dg.Failure, match="LOG_LEVEL"):
        dg.materialize([asset_def(ETH_BALANCES)], run_config=run_config)
    assert pnpm_calls == []


def test_dead_letter_check_uses_warehouse_and_schema_overrides(monkeypatch):
    monkeypatch.setenv("WAREHOUSE_DB", "warehouse")
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    run_config = {
        "ops": {
            "ethereum__eth_balances": {
                "config": {"WAREHOUSE_DB": "scratch", "RAW_SCHEMA": "staging"},
            },
        },
    }

    env = check_env(run_config, "ethereum", "eth_balances")

    assert env["WAREHOUSE_DB"] == "scratch"
    assert env["RAW_SCHEMA"] == "staging"
