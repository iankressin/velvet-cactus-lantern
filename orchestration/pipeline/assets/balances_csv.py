"""The balances CSV: analytics.requested_balances, written to a file after each balances run."""

import csv
import os
import tempfile
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import dagster as dg
from psycopg2 import sql

from pipeline.project import REPO_ROOT
from pipeline.warehouse import connect


def csv_path(run_id: str) -> Path:
    """Where a run's CSV goes: BALANCES_CSV_PATH, from the repo root, or output/balances.csv, with the run
    id before the file name, so runs never overwrite each other. An absolute path stays as it is."""
    path = REPO_ROOT / (os.environ.get("BALANCES_CSV_PATH") or "output/balances.csv")
    return path.with_name(f"{run_id}_{path.name}")


# A spreadsheet runs a cell that starts with one of these as a formula. Only an invalid input line can
# hold such text: no address, chain name, status, number or time starts with one.
FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")


def cell_text(value: Any) -> str:
    """A warehouse value as CSV text, written exactly: no float, None as empty, a time in UTC. Text a
    spreadsheet would run as a formula gets a leading ' so it shows as text; raw.input_wallet_assets
    keeps it as written."""
    if value is None:
        return ""
    if isinstance(value, str):
        return f"'{value}" if value.startswith(FORMULA_STARTS) else value
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def write_csv(path: Path, columns: Sequence[str], rows: Iterable[Sequence[Any]]) -> int:
    """Writes the header, then each row, to a temp file beside `path`, then renames it over `path`, so a
    failed write leaves the previous file whole. Creates missing folders. Returns the row count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file, lineterminator="\n")
            writer.writerow(columns)
            count = 0
            for row in rows:
                writer.writerow([cell_text(value) for value in row])
                count += 1
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    except BaseException:
        os.unlink(temp)
        raise
    return count


@dg.asset(
    key="balances_csv",
    deps=[dg.AssetKey("requested_balances")],
    group_name="output",
    kinds={"csv"},
)
def balances_csv(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
    """requested_balances as a CSV file: one row per wallet asset the input asks for, in input order."""
    path = csv_path(context.run_id)
    schema = os.environ.get("DBT_SCHEMA") or "analytics"
    statuses: Counter[str] = Counter()
    with closing(connect()) as connection, connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("select * from {}.requested_balances order by input_line").format(sql.Identifier(schema))
        )
        columns = [column.name for column in cursor.description]
        status = columns.index("status")

        def rows() -> Iterator[Sequence[Any]]:
            for row in cursor:
                statuses[row[status]] += 1
                yield row

        count = write_csv(path, columns, rows())
    return dg.MaterializeResult(
        metadata={
            "path": dg.MetadataValue.path(str(path)),
            "rows": count,
            **{f"status_{name}": n for name, n in sorted(statuses.items())},
        }
    )
