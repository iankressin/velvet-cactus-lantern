from datetime import datetime, timedelta, timezone

from pipeline.run_log import dbt_run_rows

STARTED = datetime(2026, 11, 4, 12, 0, 0, tzinfo=timezone.utc)
FINISHED = datetime(2026, 11, 4, 12, 0, 9, tzinfo=timezone.utc)


def utc(seconds: float) -> datetime:
    return datetime(2026, 11, 4, 12, 0, 0, tzinfo=timezone.utc) + timedelta(seconds=seconds)


def timing(started: str, completed: str) -> list[dict]:
    return [
        {"name": "compile", "started_at": started, "completed_at": started},
        {"name": "execute", "started_at": started, "completed_at": completed},
    ]


RUN_RESULTS = {
    "metadata": {"dbt_version": "1.12.6", "invocation_id": "3bc1596a-58a6-42b8-a629-a69e0518f556"},
    "results": [
        {
            "unique_id": "model.transformation.latest_balances",
            "status": "success",
            "timing": timing("2026-11-04T12:00:01Z", "2026-11-04T12:00:02Z"),
            "execution_time": 1.0,
            "adapter_response": {"_message": "SELECT 12", "code": "SELECT", "rows_affected": 12},
            "message": "SELECT 12",
            "failures": None,
        },
        {
            "unique_id": "model.transformation.stg_solana__sol_balances",
            "status": "success",
            "timing": timing("2026-11-04T12:00:00Z", "2026-11-04T12:00:01Z"),
            "execution_time": 0.06,
            "adapter_response": {"_message": "CREATE VIEW", "code": "CREATE VIEW", "rows_affected": -1},
            "message": "CREATE VIEW",
            "failures": None,
        },
        {
            "unique_id": "test.transformation.not_null_stg_solana__sol_balances_wallet.4e88402330",
            "status": "fail",
            "timing": timing("2026-11-04T12:00:01Z", "2026-11-04T12:00:01.5Z"),
            "execution_time": 0.04,
            "adapter_response": {"_message": "SELECT 1", "code": "SELECT", "rows_affected": 1},
            "message": "Got 2 results, configured to fail if != 0",
            "failures": 2,
        },
        {
            "unique_id": "model.transformation.solana_latest_balances",
            "status": "skipped",
            "timing": [],
            "execution_time": 0,
            "adapter_response": {},
            "message": None,
            "failures": None,
        },
    ],
}


def test_each_node_keeps_its_status_timing_rows_and_failures():
    invocation, nodes = dbt_run_rows(
        RUN_RESULTS,
        dagster_run_id="run-1",
        command="build",
        started_at=STARTED,
        finished_at=FINISHED,
        error="dbt exited with code 1",
    )
    assert invocation.invocation_id == "3bc1596a-58a6-42b8-a629-a69e0518f556"
    assert (invocation.succeeded, invocation.dbt_version) == (False, "1.12.6")
    assert [
        (n.resource_type, n.name, n.status, n.started_at, n.finished_at, n.rows_affected, n.failures)
        for n in nodes
    ] == [
        ("model", "latest_balances", "success", utc(1), utc(2), 12, None),
        ("model", "stg_solana__sol_balances", "success", utc(0), utc(1), None, None),
        ("test", "not_null_stg_solana__sol_balances_wallet", "fail", utc(1), utc(1.5), None, 2),
        ("model", "solana_latest_balances", "skipped", None, None, None, None),
    ]


def test_a_build_that_wrote_no_results_still_gets_a_row():
    invocation, nodes = dbt_run_rows(
        None,
        dagster_run_id="run-1",
        command="build",
        started_at=STARTED,
        finished_at=FINISHED,
        error="Could not connect",
    )
    assert nodes == []
    assert (invocation.succeeded, invocation.error) == (False, "Could not connect")
    assert len(invocation.invocation_id) == 36
