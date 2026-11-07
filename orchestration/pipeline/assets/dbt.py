from datetime import datetime, timezone

import dagster as dg
from dagster_dbt import DbtCliResource, dbt_assets

from pipeline.project import dbt_project
from pipeline.run_log import record_dbt_build


# Without `project`, a dbt `path:` selector resolves against the working directory, not the dbt project.
@dbt_assets(manifest=dbt_project.manifest_path, project=dbt_project)
def transformation_assets(context: dg.AssetExecutionContext, dbt: DbtCliResource):
    started_at = datetime.now(timezone.utc)
    invocation = dbt.cli(["build"], context=context, raise_on_error=False)
    try:
        yield from invocation.stream()
    finally:
        record_dbt_build(context.log, context.run_id, invocation, started_at)
    error = invocation.get_error()
    if error:
        raise error
