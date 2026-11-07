from pathlib import Path

from dagster_dbt import DbtProject

REPO_ROOT = Path(__file__).resolve().parents[2]
INGESTION_DIR = REPO_ROOT / "ingestion"

dbt_project = DbtProject(
    project_dir=REPO_ROOT / "transformation",
    profiles_dir=REPO_ROOT / "transformation",
)
# Under `dagster dev`, regenerate the dbt manifest on load. In deploys, run `dbt parse` at build time.
dbt_project.prepare_if_dev()
