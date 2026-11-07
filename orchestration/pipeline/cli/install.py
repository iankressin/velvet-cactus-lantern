"""bj install: sets a checkout up so `bj dev` and `bj run` need nothing else. It starts nothing, never
overwrites an .env, and is safe to run again."""

import shutil
import subprocess
from pathlib import Path

from dotenv import load_dotenv

from pipeline.cli import BadInput
from pipeline.cli.doctor import FAIL, check_envs
from pipeline.cli.run import parse_project

PNPM_INSTALL = ["pnpm", "install", "--frozen-lockfile"]


def run_command(command: list[str], cwd: Path, install_hint: str) -> bool:
    shown = " ".join(command)
    print(f"running `{shown}`", flush=True)
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    except FileNotFoundError:
        raise BadInput(f"{command[0]} is not on PATH; {install_hint}") from None
    if result.returncode == 0:
        return True
    output = (result.stdout + result.stderr).strip()
    print(f"`{shown}` exited with code {result.returncode}" + (f":\n{output}" if output else ""))
    return False


def copy_root_env(repo_root: Path) -> None:
    env = repo_root / ".env"
    if not env.exists():
        shutil.copyfile(repo_root / ".env.example", env)
        print("copied .env.example to .env")


def copy_package_envs(repo_root: Path) -> bool:
    checks = check_envs(repo_root, copy=True)
    for check in checks:
        print(f"{check.status}  {check.message}")
    return not any(check.status == FAIL for check in checks)


def setup(repo_root: Path) -> int:
    copy_root_env(repo_root)
    # main loaded .env before copy_root_env could create it, and dbt and Dagster read it from the environment.
    load_dotenv(repo_root / ".env", override=False)
    if not copy_package_envs(repo_root):
        return 1
    if not run_command(PNPM_INSTALL, repo_root / "ingestion", "mise.toml pins it, so `mise install` installs it"):
        return 1
    print("running `dbt parse`", flush=True)
    parse_project(repo_root / "transformation")
    return 0


def run(repo_root: Path) -> int:
    code = setup(repo_root)
    if code == 0:
        print("\nNext, start the stack and Dagster:\n  uv run --project orchestration bj dev")
    return code
