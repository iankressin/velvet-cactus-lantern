import dagster as dg
import pytest

from pipeline.cli import main
from pipeline.cli import run as run_command


@dg.asset
def loaded():
    return 1


@dg.asset(deps=[loaded])
def transformed():
    raise RuntimeError("relation raw.ethereum_eth_balances does not exist")


STUB = dg.Definitions(
    assets=[loaded, transformed],
    jobs=[dg.define_asset_job("balances", selection="*"), dg.define_asset_job("loads", selection=[loaded])],
)


@pytest.fixture
def stubbed(monkeypatch):
    parsed = []
    monkeypatch.setattr(run_command, "parse_project", parsed.append)
    monkeypatch.setattr(run_command, "load_definitions", lambda: (STUB, ["balances", "loads"]))
    return parsed


def test_unknown_pipeline_exits_2_listing_the_pipelines(stubbed, capsys):
    assert main(["run", "prices"]) == 2
    err = capsys.readouterr().err
    assert "no pipeline named 'prices'; pipelines: balances, loads" in err
    assert err.count("\n") == 1


def test_parses_the_dbt_project_then_runs_the_job(stubbed, capsys):
    assert main(["run", "loads"]) == 0
    assert [path.name for path in stubbed] == ["transformation"]
    assert "loads: run " in capsys.readouterr().out


def test_failed_run_exits_1_naming_the_failed_step(stubbed, capsys):
    assert main(["run", "balances"]) == 1
    out = capsys.readouterr().out
    assert "step transformed failed: RuntimeError: relation raw.ethereum_eth_balances does not exist" in out
    assert "step loaded" not in out


def test_wallet_assets_sends_every_source_the_absolute_csv_path(stubbed, monkeypatch, tmp_path):
    (tmp_path / "wallets.csv").write_text("blockchain,wallet_address,token_address\n")
    monkeypatch.chdir(tmp_path)
    configs = []
    monkeypatch.setattr(run_command, "materialize", lambda defs, pipelines, name, run_config: configs.append(run_config) or 0)
    assert main(["run", "balances", "--wallet-assets", "wallets.csv"]) == 0
    path = str((tmp_path / "wallets.csv").resolve())
    assert configs == [{"resources": {"ingestion_env": {"config": {"WALLET_ASSETS_CSV": path}}}}]


def test_a_missing_wallet_csv_exits_2_before_parsing(stubbed, monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    assert main(["run", "balances", "--wallet-assets", "missing.csv"]) == 2
    assert "no wallet asset CSV at" in capsys.readouterr().err
    assert stubbed == []


def test_wallet_assets_config_is_valid_for_the_real_balances_job(tmp_path):
    from pipeline.definitions import defs

    (tmp_path / "wallets.csv").write_text("blockchain,wallet_address,token_address\n")
    config = run_command.wallet_assets_config(str(tmp_path / "wallets.csv"))
    assert dg.validate_run_config(defs.resolve_job_def("balances"), config)
