import logging

import dagster as dg
import pytest

from pipeline.assets.ingestion import SOURCES, package_dir, parse_log_line
from pipeline.definitions import defs


@pytest.mark.parametrize("source, table", SOURCES)
def test_ingestion_feeds_its_staging_model(source, table):
    graph = defs.resolve_asset_graph()
    upstream = graph.get(dg.AssetKey(f"stg_{source}__{table}")).parent_keys
    assert dg.AssetKey([source, table]) in upstream


@pytest.mark.parametrize("source, table", SOURCES)
def test_ingestion_package_exists(source, table):
    assert (package_dir(source, table) / "package.json").is_file()


@pytest.mark.parametrize("source, table", SOURCES)
def test_ingestion_assets_have_dead_letter_check(source, table):
    check = dg.AssetCheckKey(dg.AssetKey([source, table]), "no_dead_letters")
    assert check in defs.resolve_asset_graph().asset_check_keys


def test_mart_reads_each_chain_through_its_intermediate_model():
    graph = defs.resolve_asset_graph()
    # tokens supplies the decimals of ERC-20 and SPL tokens.
    assert graph.get(dg.AssetKey("latest_balances")).parent_keys == {
        dg.AssetKey("int_ethereum_balances"),
        dg.AssetKey("int_solana_balances"),
        dg.AssetKey("int_bitcoin_balances"),
        dg.AssetKey("tokens"),
    }
    assert graph.get(dg.AssetKey("int_ethereum_balances")).parent_keys == {
        dg.AssetKey("stg_ethereum__eth_balances"),
        dg.AssetKey("stg_ethereum__erc20_balances"),
    }
    assert graph.get(dg.AssetKey("int_solana_balances")).parent_keys == {
        dg.AssetKey("stg_solana__sol_balances"),
        dg.AssetKey("stg_solana__spl_balances"),
    }
    assert graph.get(dg.AssetKey("int_bitcoin_balances")).parent_keys == {
        dg.AssetKey("stg_bitcoin__btc_balances"),
    }


def test_tokens_reads_each_chain_through_its_own_model():
    graph = defs.resolve_asset_graph()
    assert graph.get(dg.AssetKey("tokens")).parent_keys == {
        dg.AssetKey("int_ethereum_erc20_metadata"),
        dg.AssetKey("int_solana_spl_metadata"),
    }
    assert graph.get(dg.AssetKey("int_solana_spl_metadata")).parent_keys == {
        dg.AssetKey("stg_solana__spl_metadata"),
    }


def test_every_asset_and_check_runs_in_a_scheduled_pipeline():
    graph = defs.resolve_asset_graph()
    scheduled = {schedule.job_name for schedule in defs.schedules}
    jobs = [job for job in defs.jobs if job.name in scheduled]
    assert {key for job in jobs for key in job.selection.resolve(graph)} == graph.get_all_asset_keys()
    assert {key for job in jobs for key in job.selection.resolve_checks(graph)} == graph.asset_check_keys


def test_balances_job_ingests_the_balances_and_every_source_tokens_reads():
    graph = defs.resolve_asset_graph()
    job = next(job for job in defs.jobs if job.name == "balances")
    ingested = {key for key in job.selection.resolve(graph) if tuple(key.path) in SOURCES}
    # latest_balances takes token decimals from tokens, so the job also loads every metadata source tokens
    # reads. A failed load there skips the job's dbt step.
    # requested_balances reads the input list, so the job also loads it.
    assert ingested == {
        dg.AssetKey(["ethereum", "eth_balances"]),
        dg.AssetKey(["ethereum", "erc20_balances"]),
        dg.AssetKey(["solana", "sol_balances"]),
        dg.AssetKey(["solana", "spl_balances"]),
        dg.AssetKey(["bitcoin", "btc_balances"]),
        dg.AssetKey(["ethereum", "erc20_metadata"]),
        dg.AssetKey(["solana", "spl_metadata"]),
        dg.AssetKey(["input", "wallet_assets"]),
    }


def test_requested_balances_joins_the_input_to_latest_balances():
    graph = defs.resolve_asset_graph()
    assert graph.get(dg.AssetKey("requested_balances")).parent_keys == {
        dg.AssetKey("stg_input__wallet_assets"),
        dg.AssetKey("latest_balances"),
    }


def test_balances_csv_reads_requested_balances_in_the_balances_job():
    graph = defs.resolve_asset_graph()
    assert graph.get(dg.AssetKey("balances_csv")).parent_keys == {dg.AssetKey("requested_balances")}
    job = next(job for job in defs.jobs if job.name == "balances")
    assert dg.AssetKey("balances_csv") in job.selection.resolve(graph)


def test_pino_line_logs_at_its_level_with_its_fields():
    line = '{"level":40,"time":1,"pid":2,"hostname":"h","source":"ethereum","table":"eth_balances","failedCalls":3,"msg":"Some calls failed"}'
    assert parse_log_line(line) == (logging.WARNING, "Some calls failed failedCalls=3")


def test_pino_fatal_line_carries_the_stack():
    line = '{"level":60,"msg":"Run failed","err":{"type":"Error","message":"boom","stack":"Error: boom\\n    at run"}}'
    assert parse_log_line(line) == (logging.CRITICAL, "Run failed\nError: boom\n    at run")


def test_other_output_logs_as_info():
    assert parse_log_line("not json") == (logging.INFO, "not json")
    assert parse_log_line("42") == (logging.INFO, "42")
