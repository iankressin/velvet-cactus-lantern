import dagster as dg
from dagster_dbt import DbtCliResource

from pipeline.assets.dbt import transformation_assets
from pipeline.assets.ingestion import ingestion_assets, ingestion_checks
from pipeline.project import dbt_project
from pipeline.schedules import jobs, schedules

defs = dg.Definitions(
    assets=[*ingestion_assets, transformation_assets],
    asset_checks=ingestion_checks,
    jobs=jobs,
    schedules=schedules,
    resources={"dbt": DbtCliResource(project_dir=dbt_project)},
)
