import dagster as dg
from dagster_dbt import build_dbt_asset_selection

from pipeline.assets.dbt import transformation_assets

PIPELINES = {
    "balances": "0 6 * * *",
    "transfers": "0 6 * * *",
    "dex": "0 6 * * *",
    "labels": "0 6 * * *",
    "bridges": "0 6 * * *",
    "prices": "0 6 * * *",
    "tokens": "0 6 * * *",
}

jobs = [
    dg.define_asset_job(
        name,
        selection=build_dbt_asset_selection(
            [transformation_assets], dbt_select=f"path:models/marts/{name}"
        ).upstream(),
    )
    for name in PIPELINES
]

schedules = [dg.ScheduleDefinition(job=job, cron_schedule=PIPELINES[job.name]) for job in jobs]
