# Change when a pipeline runs

Dagster is the only scheduler. `PIPELINES` in `orchestration/pipeline/schedules.py` maps each pipeline's name to its cron, and the rest of that file builds one job and one schedule per entry:

```python
PIPELINES = {
    "balances": "0 6 * * *",
    "transfers": "0 6 * * *",
    "dex": "0 6 * * *",
}
```

The job of `<name>` selects the dbt models under `models/marts/<name>` and everything upstream of them, ingestion assets included, so one tick runs the whole pipeline: sources first, then dbt. Today every pipeline runs daily at 06:00 UTC. A cron with no timezone runs in UTC.

1. Edit the pipeline's cron in `PIPELINES`. That is the whole change. Five cron fields: `0 6 * * *` is daily at 06:00, `0 */6 * * *` every six hours, `0 6 * * 1` Mondays at 06:00. Two pipelines that read the same source each run it, so two pipelines that share a source and a time load it twice.
2. Check that it loads: `cd orchestration && uv run pytest`. The tests load the definitions, and Dagster refuses a cron it cannot read, so a wrong cron fails them. Every key must be a folder in `transformation/models/marts/`. Removing a pipeline from the dict leaves its assets with no scheduled job, which `test_every_asset_and_check_runs_in_a_scheduled_pipeline` reports.
3. Reload Dagster. `dagster dev` does not reread the file on its own: restart it (Ctrl-C, then `uv run --project orchestration bj dev`) or reload the code location in its UI at http://localhost:3000. Then open Automation there: the schedule shows the new cron and its next tick. A schedule starts stopped, so turn it on there. Without `DAGSTER_HOME` set, `dagster dev` keeps that state in a temporary folder and forgets it when it stops, so turn the schedule on again after each restart.
4. Prove it. After the tick, the run is under Runs in the Dagster UI, started by the schedule, and on the Grafana pipeline dashboard at http://localhost:3001/d/pipeline, whose Every run table lists each Dagster run with its id, sources, models and tests. Click the run to see its steps. To see the job run without waiting for the tick, `uv run --project orchestration bj run <pipeline>` runs the same job in this process.

Never:

- add Airflow, a crontab, a compose service or any other scheduler. Dagster's is the only one;
- schedule one asset, model or source on its own, or give a pipeline a second job or schedule. One job and one schedule per pipeline, both from `PIPELINES`;
- edit `jobs` or `schedules` below the dict. `PIPELINES` is the only thing to change.
