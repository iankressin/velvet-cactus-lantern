from datetime import datetime, timezone
from decimal import Decimal

import pytest

from pipeline.assets.balances_csv import csv_path, write_csv
from pipeline.project import REPO_ROOT


def test_writes_the_header_then_each_row_exactly(tmp_path):
    path = tmp_path / "balances.csv"
    columns = ["blockchain", "wallet_address", "token_address", "balance_tokens", "read_at", "input_line"]
    rows = [
        (
            "ethereum",
            "0xAbC",
            None,
            Decimal("1234567890.123456789012345678"),
            datetime(2026, 11, 7, 6, 1, tzinfo=timezone.utc),
            2,
        ),
        ("ethereum", "0xAbC", "0xUSDC", Decimal("0.000000000000000001"), None, 3),
    ]

    assert write_csv(path, columns, rows) == 2
    assert path.read_text() == (
        "blockchain,wallet_address,token_address,balance_tokens,read_at,input_line\n"
        "ethereum,0xAbC,,1234567890.123456789012345678,2026-11-07T06:01:00Z,2\n"
        "ethereum,0xAbC,0xUSDC,0.000000000000000001,,3\n"
    )


def test_a_text_cell_a_spreadsheet_would_run_as_a_formula_is_written_as_text(tmp_path):
    path = tmp_path / "balances.csv"
    write_csv(path, ["a", "b", "c", "d", "e", "f"], [("=1+1", "+1", "-1", "@A1", "\tx", "0xAbC")])
    assert path.read_text() == "a,b,c,d,e,f\n'=1+1,'+1,'-1,'@A1,'\tx,0xAbC\n"


def test_creates_missing_folders(tmp_path):
    path = tmp_path / "a" / "b" / "balances.csv"
    write_csv(path, ["input_line"], [(2,)])
    assert path.is_file()


def test_a_failed_write_keeps_the_previous_file(tmp_path):
    path = tmp_path / "balances.csv"
    path.write_text("old\n")

    def rows():
        yield ("ethereum",)
        raise RuntimeError("the warehouse went away")

    with pytest.raises(RuntimeError):
        write_csv(path, ["blockchain"], rows())
    assert path.read_text() == "old\n"
    assert list(tmp_path.iterdir()) == [path]


def test_csv_path_defaults_to_output_balances_csv_under_the_run_id(monkeypatch):
    monkeypatch.delenv("BALANCES_CSV_PATH", raising=False)
    assert csv_path("run-1") == REPO_ROOT / "output" / "run-1_balances.csv"


def test_csv_path_puts_the_run_id_before_the_balances_csv_path_file_name(monkeypatch, tmp_path):
    monkeypatch.setenv("BALANCES_CSV_PATH", "elsewhere/out.csv")
    assert csv_path("run-1") == REPO_ROOT / "elsewhere" / "run-1_out.csv"
    monkeypatch.setenv("BALANCES_CSV_PATH", str(tmp_path / "out.csv"))
    assert csv_path("run-1") == tmp_path / "run-1_out.csv"


def test_each_run_gets_its_own_file(monkeypatch):
    monkeypatch.delenv("BALANCES_CSV_PATH", raising=False)
    assert csv_path("run-1") != csv_path("run-2")
