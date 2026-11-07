"""bj doctor: checks the local setup before a run: the env files and the keys they set, the compose
ports, the warehouse, the eRPC and Dshackle health endpoints, and the tool versions mise.toml pins.

Each check prints one PASS, WARN or FAIL line. A key is named, never its value. WARN marks what a
run can do without, such as a port that compose has not opened yet; FAIL marks what stops a run.
"""

import os
import re
import shutil
import socket
import subprocess
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

import psycopg2
import requests
from dotenv import dotenv_values

from pipeline.cli import REQUIRED_ENV, BadInput
from pipeline.sources import SOURCES_FILE, read_sources
from pipeline.warehouse import connect

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"

# Keys a source package reads with a default, or does without, so its .env may leave them out. The
# zod schema that makes each one optional:
#   PUSHGATEWAY_URL    ingestion/lib/src/run/metrics.ts: unset pushes no metrics
#   LOG_LEVEL          ingestion/lib/src/logger.ts: info
#   RPC_BATCH_SIZE     ingestion/lib/src/evm/env.ts: 100
#   RPC_MAX_CONCURRENCY ingestion/lib/src/evm/env.ts: 16
#   PORTAL_URL         ingestion/sources/*/src/source.ts: the public Portal
#   POOLS_START_BLOCK  ingestion/sources/evm-uniswap-*/src/source.ts: the factory's deploy block
#   END_BLOCK          ingestion/sources/evm-uniswap-*/src/source.ts: unset reads to the head
#   FACTORY_DB         ingestion/sources/evm-uniswap-*/src/source.ts: chains/<chain>/factory.sqlite
OPTIONAL_KEYS = frozenset(
    {
        "PUSHGATEWAY_URL",
        "LOG_LEVEL",
        "RPC_BATCH_SIZE",
        "RPC_MAX_CONCURRENCY",
        "PORTAL_URL",
        "POOLS_START_BLOCK",
        "END_BLOCK",
        "FACTORY_DB",
    }
)

# The compose ports, each with the root .env variable that moves it and the default of both
# infra/docker-compose.yml (${NAME:-default}) and this check.
COMPOSE_PORTS = (
    ("warehouse", "WAREHOUSE_PORT", 5432),
    ("erpc", "ERPC_PORT", 4000),
    ("erpc metrics", "ERPC_METRICS_PORT", 4001),
    ("dshackle", "DSHACKLE_PORT", 8545),
    ("dshackle health", "DSHACKLE_HEALTH_PORT", 8082),
    ("grafana", "GRAFANA_PORT", 3001),
    ("prometheus", "PROMETHEUS_PORT", 9090),
    ("pushgateway", "PUSHGATEWAY_PORT", 9091),
)
# `dagster dev`'s own port, which no setting moves.
DAGSTER_PORT = 3000
PORTS = (*COMPOSE_PORTS, ("dagster", None, DAGSTER_PORT))
# Root keys that docker compose (the ports and MONITOR_PASSWORD) and dbt (DBT_SCHEMA, in
# transformation/profiles.yml) default when unset. Not WAREHOUSE_PORT: dbt and bj read it with no default.
ROOT_OPTIONAL_KEYS = (
    OPTIONAL_KEYS | {key for _, key, _ in PORTS if key} | {"MONITOR_PASSWORD", "DBT_SCHEMA"}
) - set(REQUIRED_ENV)
# The root settings pipeline.warehouse.connect reads.
CONNECT_ENV = tuple(name for name in REQUIRED_ENV if name.startswith("WAREHOUSE_"))
# The compose services with a health endpoint. eRPC serves /healthcheck without a healthCheck
# section in infra/erpc/erpc.yaml; Dshackle's path is the health.path of infra/dshackle/dshackle.yaml.
HEALTH = (("erpc", "ERPC_PORT", "/healthcheck"), ("dshackle", "DSHACKLE_HEALTH_PORT", "/health"))
# The services answer these while their upstreams are still coming up.
STARTING = (502, 503)
TIMEOUT = 3
# The tools mise.toml pins, with the prefix their --version prints before the number.
PINNED_TOOLS = (("node", "v"), ("pnpm", ""))


@dataclass(frozen=True)
class Check:
    status: str
    message: str


def required_keys(example: Path, optional: frozenset[str]) -> set[str]:
    """The keys an .env.example sets, less the optional ones. A commented-out `# KEY=` line and a
    `KEY=` left empty are optional too."""
    return {key for key, value in dotenv_values(example).items() if value} - optional


def set_keys(env: Path) -> set[str]:
    """The keys an .env sets to something. Ingestion reads an empty value as unset."""
    return {key for key, value in dotenv_values(env).items() if value}


def check_env(repo_root: Path, folder: Path, optional: frozenset[str], missing_status: str, copy: bool) -> Check:
    """One line for a folder's .env: missing, lacking required keys, or complete. With copy, a missing
    .env is copied from .env.example first. An existing .env is never written."""
    env, example = folder / ".env", folder / ".env.example"
    label = env.relative_to(repo_root)
    if not example.is_file():
        return Check(FAIL, f"{label}: no .env.example to compare against")
    copied = False
    if not env.exists():
        if not copy:
            return Check(missing_status, f"{label} is missing; copy {example.relative_to(repo_root)} to it")
        shutil.copyfile(example, env)
        copied = True
    missing = sorted(required_keys(example, optional) - set_keys(env))
    if missing:
        return Check(FAIL, f"{label} lacks {', '.join(missing)}")
    return Check(PASS, f"{label} copied from .env.example" if copied else f"{label} sets every required key")


def check_chain_env(repo_root: Path, folder: Path) -> Check:
    """One line for a chain's .env in a package that loads several chains. loadEnv in ingestion/lib
    loads the chain's .env.example beneath its .env, so the .env may be missing or set only the keys it
    changes. It fails only when it leaves empty a key the .env.example sets."""
    env, example = folder / ".env", folder / ".env.example"
    label = env.relative_to(repo_root)
    if not example.is_file():
        return Check(FAIL, f"{label}: no .env.example to compare against")
    if not env.exists():
        return Check(PASS, f"{label} is missing, so {example.relative_to(repo_root)} applies")
    emptied = sorted(required_keys(example, OPTIONAL_KEYS) & (set(dotenv_values(env)) - set_keys(env)))
    if emptied:
        return Check(FAIL, f"{label} leaves {', '.join(emptied)} empty")
    return Check(PASS, f"{label} sets no required key empty")


def check_envs(repo_root: Path, copy: bool) -> list[Check]:
    """The root .env, then the .env of every package in sources.json, and of each chain in a package
    that loads several chains. With copy, a package's missing .env is copied from its .env.example, but
    the root .env never is: bj install copies that one itself."""
    checks = [check_env(repo_root, repo_root, ROOT_OPTIONAL_KEYS, FAIL, False)]
    entries = read_sources((repo_root / SOURCES_FILE).read_text())
    for package in dict.fromkeys(entry.package for entry in entries):
        folder = repo_root / "ingestion" / "sources" / package
        if not folder.is_dir():
            checks.append(Check(FAIL, f"{SOURCES_FILE} names package {package!r}, which is not under ingestion/sources/"))
            continue
        checks.append(check_env(repo_root, folder, OPTIONAL_KEYS, WARN, copy))
        checks += [
            check_chain_env(repo_root, entry.folder(repo_root))
            for entry in entries
            if entry.package == package and entry.settings
        ]
    return checks


def root_settings(repo_root: Path) -> dict[str, str | None]:
    """The root settings in force: .env, else .env.example, which holds the defaults."""
    for name in (".env", ".env.example"):
        if (repo_root / name).is_file():
            return dotenv_values(repo_root / name)
    return {}


def port_of(settings: dict[str, str | None], key: str | None, default: int) -> int:
    value = settings.get(key) if key else None
    if not value:
        return default
    if not value.isdigit():
        raise BadInput(f"{key} in .env must be a port number")
    return int(value)


def port_open(port: int) -> bool:
    try:
        with closing(socket.create_connection(("localhost", port), timeout=TIMEOUT)):
            return True
    except OSError:
        return False


def check_ports(settings: dict[str, str | None], ports: tuple[tuple[str, str | None, int], ...]) -> list[Check]:
    checks = []
    for name, key, default in ports:
        port = port_of(settings, key, default)
        if port_open(port):
            checks.append(Check(PASS, f"port {port} ({name}) is open"))
        else:
            checks.append(Check(WARN, f"port {port} ({name}) is closed; is docker compose up?"))
    return checks


def check_warehouse() -> Check:
    unset = [name for name in CONNECT_ENV if not os.environ.get(name)]
    if unset:
        return Check(FAIL, f"warehouse: set {', '.join(unset)} in .env")
    try:
        with closing(connect()) as connection, connection.cursor() as cursor:
            cursor.execute("select 1")
    except psycopg2.Error as error:
        return Check(FAIL, f"warehouse: {' '.join(str(error).split())}")
    return Check(PASS, "warehouse answers")


def check_health(name: str, url: str) -> Check:
    try:
        response = requests.get(url, timeout=TIMEOUT)
    except requests.ConnectionError:
        return Check(WARN, f"{name}: nothing answers at {url}; is docker compose up?")
    except requests.RequestException as error:
        return Check(WARN, f"{name}: {url} failed: {error}")
    if response.status_code == 200:
        return Check(PASS, f"{name} is healthy at {url}")
    if response.status_code in STARTING:
        return Check(WARN, f"{name}: {url} answered {response.status_code}; its upstreams may still be starting")
    return Check(FAIL, f"{name}: {url} answered {response.status_code}")


def check_healths(settings: dict[str, str | None]) -> list[Check]:
    checks = []
    for name, key, path in HEALTH:
        port = port_of(settings, key, next(default for _, k, default in PORTS if k == key))
        checks.append(check_health(name, f"http://localhost:{port}{path}"))
    return checks


def pins(repo_root: Path) -> dict[str, str]:
    """The versions mise.toml pins, by tool."""
    path = repo_root / "mise.toml"
    if not path.is_file():
        raise BadInput("mise.toml is missing")
    return dict(re.findall(r'^\s*([\w-]+)\s*=\s*"([^"]+)"', path.read_text(), re.MULTILINE))


def installed_version(tool: str) -> str | None:
    """What `<tool> --version` prints, or None when the tool is not on PATH."""
    try:
        result = subprocess.run([tool, "--version"], capture_output=True, text=True)
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def matches(installed: str, pin: str) -> bool:
    """A pin names the leading parts: node "24" matches 24.11.0, pnpm "10.17.0" only 10.17.0."""
    wanted = pin.split(".")
    return installed.split(".")[: len(wanted)] == wanted


def check_tools(repo_root: Path) -> list[Check]:
    pinned = pins(repo_root)
    checks = []
    for tool, prefix in PINNED_TOOLS:
        pin = pinned.get(tool)
        if pin is None:
            raise BadInput(f"mise.toml pins no {tool} version")
        printed = installed_version(tool)
        if printed is None:
            checks.append(Check(WARN, f"{tool} is not installed; mise.toml pins {pin}"))
            continue
        version = printed.removeprefix(prefix)
        if matches(version, pin):
            checks.append(Check(PASS, f"{tool} {version} matches the {pin} mise.toml pins"))
        else:
            checks.append(Check(WARN, f"{tool} is {version}; mise.toml pins {pin}"))
    uv = installed_version("uv")
    # `uv --version` prints "uv 0.9.5 (build)".
    checks.append(Check(PASS, f"{' '.join(uv.split()[:2])} is installed") if uv else Check(WARN, "uv is not installed"))
    return checks


def run(repo_root: Path, copy_env: bool, ports: tuple[tuple[str, str | None, int], ...] = PORTS) -> int:
    settings = root_settings(repo_root)
    checks = [
        *check_envs(repo_root, copy_env),
        *check_ports(settings, ports),
        check_warehouse(),
        *check_healths(settings),
        *check_tools(repo_root),
    ]
    for check in checks:
        print(f"{check.status}  {check.message}")
    counts = {status: sum(check.status == status for check in checks) for status in (PASS, WARN, FAIL)}
    print(f"{counts[PASS]} passed, {counts[WARN]} warnings, {counts[FAIL]} failed")
    return 1 if counts[FAIL] else 0
