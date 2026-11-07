import os
import uuid
from contextlib import closing

import psycopg2
import pytest
from psycopg2 import sql

from pipeline.warehouse import read_cursor

SERVER = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD")


@pytest.fixture(scope="module")
def scratch():
    """A database of its own on the Postgres server .env names, dropped after the module's tests,
    so they read and write nothing of the warehouse's."""
    if not all(os.environ.get(name) for name in SERVER):
        pytest.skip(f"set {', '.join(SERVER)} to a Postgres server, as .env.example does")
    settings = dict(zip(("host", "port", "user", "password"), (os.environ[name] for name in SERVER)))
    try:
        admin = psycopg2.connect(**settings, dbname="postgres")
    except psycopg2.OperationalError as error:
        pytest.skip(f"no Postgres server at {settings['host']}:{settings['port']}: {' '.join(str(error).split())}")
    admin.autocommit = True
    name = f"bj_test_{uuid.uuid4().hex[:12]}"
    with closing(admin), admin.cursor() as cursor:
        cursor.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
        try:
            yield {**settings, "dbname": name}
        finally:
            cursor.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(name)))


@pytest.fixture
def database(scratch, monkeypatch):
    """The scratch database with no raw schema, as warehouse.connect() reaches it. Returns a function that runs SQL in it."""
    monkeypatch.setenv("WAREHOUSE_DB", scratch["dbname"])
    monkeypatch.setenv("RAW_SCHEMA", "raw")

    def execute(statement: str) -> None:
        with closing(psycopg2.connect(**scratch)) as connection, connection, connection.cursor() as cursor:
            cursor.execute(statement)

    execute("drop schema if exists raw cascade")
    return execute


# The columns of the _sync table Pipes creates that a row cannot leave empty. Pipes saves a row per
# batch, so a stream source has several.
SYNC = "create schema raw; create table raw._sync (id text not null, current_number numeric not null, current_hash text not null)"


def test_no_cursor_before_pipes_creates_its_table(database):
    assert read_cursor("ethereum_erc20_transfers") is None


def test_the_cursor_is_the_highest_block_saved_for_the_source(database):
    database(
        SYNC + "; insert into raw._sync values"
        " ('ethereum_erc20_transfers', 150, '0xa'), ('ethereum_erc20_transfers', 180, '0xb'),"
        " ('ethereum_erc20_transfers', 120, '0xc'), ('ethereum_other_transfers', 999, '0xd')"
    )
    assert read_cursor("ethereum_erc20_transfers") == 180


def test_no_cursor_for_a_source_with_no_rows_while_another_has_some(database):
    database(SYNC + "; insert into raw._sync values ('ethereum_other_transfers', 999, '0xd')")
    assert read_cursor("ethereum_erc20_transfers") is None
