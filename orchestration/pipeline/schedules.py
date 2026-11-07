import dagster as dg
from dagster_dbt import build_dbt_asset_selection

from pipeline.assets.balances_csv import balances_csv
from pipeline.assets.dbt import transformation_assets

PIPELINES = {
    "balances": "0 6 * * *",
}

# The assets each pipeline writes after its marts, outside dbt.
OUTPUTS = {
    "balances": [balances_csv],
}

jobs = [
    dg.define_asset_job(
        name,
        selection=build_dbt_asset_selection(
            [transformation_assets], dbt_select=f"path:models/marts/{name}"
        ).upstream()
        | dg.AssetSelection.assets(*OUTPUTS.get(name, [])),
    )
    for name in PIPELINES
]

schedules = [dg.ScheduleDefinition(job=job, cron_schedule=PIPELINES[job.name]) for job in jobs]
