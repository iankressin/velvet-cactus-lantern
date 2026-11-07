"""The singular dbt tests on erc20_transfers, which reconcile it with balance readings: compiled by dbt with
var('coverage') as bj answer passes it, then run with DuckDB on sample tables, without the warehouse."""

import json
from pathlib import Path

import duckdb
import pytest
from dbt.cli.main import dbtRunner

from pipeline.cli.answer import DBT_FLAGS
from pipeline.cli.coverage import Coverage

PROJECT = Path(__file__).resolve().parents[2] / "transformation"
# addresses.json may hold checksummed addresses; the warehouse holds them in lower case.
WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60"
TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
W, T = WALLET.lower(), TOKEN.lower()
OTHER = "0x00000000000000000000000000000000000000aa"
# A quote in addresses.json must not break the SQL.
LOADED = Coverage(
    "ethereum", "erc20_transfers", "raw.ethereum_erc20_transfers", 100, ".env", 180, {"wallets": [WALLET, "0xab'c"], "tokens": [TOKEN]}
)

# The readings of the tracked wallet and token at blocks 99 to 180 agree with the transfers. Every other
# reading disagrees, so a test that compares one fails.
BALANCES = [
    (W, T, 50, 999),
    (W, T, 99, 0),
    (W, T, 120, None),
    (W, T, 150, 15),
    (W, T, 180, 12),
    (W, T, 200, 500),
    (OTHER, T, 99, 0),
    (OTHER, T, 150, 77),
    (W, OTHER, 99, 0),
    (W, OTHER, 150, 77),
]
# a and c land in the block of a reading, which already counts them.
TRANSFERS = [
    ("a", T, OTHER, W, 99, 1000),
    ("b", T, OTHER, W, 100, 10),
    ("c", T, OTHER, W, 150, 5),
    ("d", T, W, OTHER, 160, 3),
    ("e", T, W, W, 170, 50),
    ("f", T, OTHER, W, 181, 93),
]
# A fresh setup reads balances at the tip while transfers stop at the finalized head: no two readings
# fall inside the loaded blocks, so the reconciliation has no pair to compare.
ONE_READING = [(W, T, 50, 999), (W, T, 150, 15), (W, T, 200, 500)]


def compile_tests(target: Path, variables: dict | None) -> dict[str, tuple[str, str]]:
    """Each singular test downstream of erc20_transfers, by name: its severity and its compiled SQL."""
    args = [
        "compile", "--select", "test_type:singular,erc20_transfers+", "--project-dir", str(PROJECT), "--profiles-dir",
        str(PROJECT), "--target-path", str(target), "--log-path", str(target), "--no-populate-cache", *DBT_FLAGS,
    ]
    result = dbtRunner().invoke([*args, "--vars", json.dumps(variables)] if variables else args)
    assert result.success, result.exception
    return {r.node.name: (r.node.config.severity.lower(), r.node.compiled_code) for r in result.result.results}


@pytest.fixture(scope="module")
def compiled(tmp_path_factory):
    """The tests compiled with and without var('coverage'). Port 1 has no server, so compiling reaches no warehouse."""
    profile = {"WAREHOUSE_HOST": "localhost", "WAREHOUSE_PORT": "1", "WAREHOUSE_USER": "x", "WAREHOUSE_PASSWORD": "x"}
    with pytest.MonkeyPatch.context() as env:
        for name, value in {**profile, "WAREHOUSE_DB": "warehouse", "DBT_SCHEMA": "analytics"}.items():
            env.setenv(name, value)
        return {
            "loaded": compile_tests(tmp_path_factory.mktemp("loaded"), {"coverage": {LOADED.name: LOADED.to_json()}}),
            "no var": compile_tests(tmp_path_factory.mktemp("no-var"), None),
        }


def run(tests: dict[str, tuple[str, str]], balances: list[tuple], transfers: list[tuple]) -> dict[str, tuple[str, list]]:
    """Each test's severity and the rows it returns, on DuckDB tables named as dbt compiled them."""
    db = duckdb.connect()
    db.execute("attach ':memory:' as warehouse; create schema warehouse.analytics")
    db.execute(
        "create table warehouse.analytics.stg_ethereum__erc20_balances"
        " (wallet text, token text, block_number bigint, balance decimal(38, 0))"
    )
    db.execute(
        "create table warehouse.analytics.erc20_transfers"
        " (id text, token text, from_address text, to_address text, block_number bigint, value decimal(38, 0), chain text)"
    )
    db.executemany("insert into warehouse.analytics.stg_ethereum__erc20_balances values (?, ?, ?, ?)", balances)
    rows = [transfer if len(transfer) == 7 else (*transfer, "ethereum") for transfer in transfers]
    db.executemany("insert into warehouse.analytics.erc20_transfers values (?, ?, ?, ?, ?, ?, ?)", rows)
    return {name: (severity, db.execute(sql).fetchall()) for name, (severity, sql) in tests.items()}


def test_the_reconciliation_is_among_the_tests(compiled):
    assert "erc20_transfers_match_balances" in compiled["loaded"]


def test_consistent_readings_inside_the_loaded_blocks_return_no_rows(compiled):
    assert {name: rows for name, (_, rows) in run(compiled["loaded"], BALANCES, TRANSFERS).items() if rows} == {}


def test_a_transfer_on_another_chain_does_not_count_toward_an_ethereum_balance(compiled):
    # The same token and wallet addresses on Arbitrum, inside the loaded blocks.
    elsewhere = ("g", T, OTHER, W, 160, 7, "arbitrum")
    assert {name: rows for name, (_, rows) in run(compiled["loaded"], BALANCES, [*TRANSFERS, elsewhere]).items() if rows} == {}


@pytest.mark.parametrize(
    "missing, pair",
    [
        ("b", (W, T, 99, 150, 15, 5, 1)),
        ("d", (W, T, 150, 180, -3, 0, 1)),
    ],
)
def test_a_missing_transfer_fails_the_pair_of_readings_around_it(compiled, missing, pair):
    found = run(compiled["loaded"], BALANCES, [t for t in TRANSFERS if t[0] != missing])
    assert found["erc20_transfers_match_balances"] == ("error", [pair])


def test_no_pair_of_readings_inside_the_loaded_blocks_warns(compiled):
    found = run(compiled["loaded"], ONE_READING, TRANSFERS)
    assert {name: (severity, len(rows)) for name, (severity, rows) in found.items() if rows} == {
        "erc20_transfers_match_balances_has_pairs": ("warn", 1)
    }


@pytest.mark.parametrize("balances", [BALANCES, ONE_READING])
def test_without_the_coverage_var_no_test_returns_rows(compiled, balances):
    found = run(compiled["no var"], balances, [t for t in TRANSFERS if t[0] != "b"])
    assert {name: rows for name, (_, rows) in found.items() if rows} == {}
