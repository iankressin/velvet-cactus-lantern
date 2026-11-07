import json
import subprocess
from types import SimpleNamespace

import psycopg2
import pytest

from pipeline.cli import main
from pipeline.cli import doctor
from pipeline.sources import SOURCES_FILE

ROOT_EXAMPLE = """\
WAREHOUSE_HOST=localhost
WAREHOUSE_PORT=5432
WAREHOUSE_USER=elt
WAREHOUSE_PASSWORD=elt
WAREHOUSE_DB=warehouse
RAW_SCHEMA=raw
ERPC_PORT=4000
DSHACKLE_HEALTH_PORT=8082
PUSHGATEWAY_URL=http://localhost:9091
# GOOGLE_OAUTH_CLIENT_SECRET=
"""
ROOT_ENV = ROOT_EXAMPLE.replace("WAREHOUSE_PASSWORD=elt", "WAREHOUSE_PASSWORD=root-pw-9f3a").replace("ERPC_PORT=4000", "ERPC_PORT=4100")
BALANCES_EXAMPLE = """\
WAREHOUSE_HOST=localhost
WAREHOUSE_PASSWORD=elt
BLOCK_NUMBER=finalized
ERPC_URL=https://eth.drpc.org
RPC_BATCH_SIZE=3
# Each ingestion run pushes its metrics here. Leave it empty to push none.
PUSHGATEWAY_URL=http://localhost:9091
LOG_LEVEL=info
"""
TRANSFERS_EXAMPLE = """\
WAREHOUSE_HOST=localhost
PORTAL_URL=https://portal.sqd.dev/datasets/ethereum-mainnet
START_BLOCK=100
# END_BLOCK=
"""
PACKAGES = {"ethereum-eth-balances": BALANCES_EXAMPLE, "ethereum-erc20-transfers": TRANSFERS_EXAMPLE}
ROOT_KEYS = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB", "RAW_SCHEMA",
             "ERPC_PORT", "DSHACKLE_HEALTH_PORT", "PUSHGATEWAY_URL")


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A repo with a root .env.example, two source packages with their .env.example and a mise.toml, and no
    .env anywhere. The root keys are set in the environment, as a shell that sourced .env would have them."""
    (tmp_path / ".env.example").write_text(ROOT_EXAMPLE)
    (tmp_path / "mise.toml").write_text('[tools]\nnode = "24"\npnpm = "10.17.0"\n')
    (tmp_path / SOURCES_FILE).parent.mkdir(parents=True)
    entries = []
    for package, example in PACKAGES.items():
        folder = tmp_path / "ingestion" / "sources" / package
        folder.mkdir(parents=True)
        (folder / ".env.example").write_text(example)
        entries.append({"name": "ethereum", "table": package.removeprefix("ethereum-").replace("-", "_"), "package": package})
    (tmp_path / SOURCES_FILE).write_text(json.dumps(entries))
    for key in ROOT_KEYS:
        monkeypatch.setenv(key, "x")
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    return tmp_path


def with_envs(repo):
    """Every .env copied from its .env.example."""
    for folder in (repo, *(repo / "ingestion" / "sources" / package for package in PACKAGES)):
        (folder / ".env").write_text((folder / ".env.example").read_text())


class FakeCursor:
    def execute(self, sql):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class Services:
    """Fakes for everything bj doctor reaches outside the repo: sockets, HTTP, the warehouse and the tools."""

    def __init__(self, monkeypatch):
        self.open_ports: set[int] = set()
        self.statuses: dict[str, int] = {}
        self.requested: list[str] = []
        self.warehouse_error: str | None = "connection to server at \"localhost\" (127.0.0.1), port 5432 failed"
        self.versions = {"node": "v24.11.0", "pnpm": "10.17.0", "uv": "uv 0.9.5"}
        monkeypatch.setattr(doctor.socket, "create_connection", self.connect_socket)
        monkeypatch.setattr(doctor.requests, "get", self.get)
        monkeypatch.setattr(doctor, "connect", self.connect_warehouse)
        monkeypatch.setattr(doctor.subprocess, "run", self.run_tool)

    def connect_socket(self, address, timeout):
        if address[1] not in self.open_ports:
            raise ConnectionRefusedError
        return SimpleNamespace(close=lambda: None)

    def get(self, url, timeout):
        self.requested.append(url)
        if url not in self.statuses:
            raise doctor.requests.ConnectionError(url)
        return SimpleNamespace(status_code=self.statuses[url])

    def connect_warehouse(self):
        if self.warehouse_error:
            raise psycopg2.OperationalError(self.warehouse_error)
        return SimpleNamespace(cursor=FakeCursor, close=lambda: None)

    def run_tool(self, command, capture_output, text):
        if command[0] not in self.versions:
            raise FileNotFoundError(command[0])
        return subprocess.CompletedProcess(command, 0, self.versions[command[0]] + "\n", "")

    def all_up(self):
        self.open_ports = {5432, 4000, 4001, 8545, 8082, 3001, 9090, 9091, 3000}
        self.statuses = {"http://localhost:4000/healthcheck": 200, "http://localhost:8082/health": 200}
        self.warehouse_error = None


@pytest.fixture
def services(monkeypatch):
    return Services(monkeypatch)


def lines(capsys) -> list[str]:
    return capsys.readouterr().out.splitlines()


def test_doctor_fails_without_root_env(repo, services, capsys):
    assert main(["doctor"]) == 1
    out = lines(capsys)
    assert "FAIL  .env is missing; copy .env.example to it" in out
    assert out[-1].endswith("failed") and not out[-1].startswith("0 passed, 0 warnings, 0")


def test_doctor_warns_missing_source_env(repo, services, capsys):
    (repo / ".env").write_text(ROOT_ENV)
    main(["doctor"])
    out = lines(capsys)
    assert "PASS  .env sets every required key" in out
    for package in PACKAGES:
        assert f"WARN  ingestion/sources/{package}/.env is missing; copy ingestion/sources/{package}/.env.example to it" in out


def test_doctor_copy_env_flag_copies_example(repo, services, capsys):
    (repo / ".env").write_text(ROOT_ENV)
    kept = repo / "ingestion" / "sources" / "ethereum-eth-balances" / ".env"
    kept.write_text("ERPC_URL=https://keyed.example/abc123\nBLOCK_NUMBER=latest\nWAREHOUSE_HOST=h\nWAREHOUSE_PASSWORD=p\n")
    copied = repo / "ingestion" / "sources" / "ethereum-erc20-transfers" / ".env"

    main(["doctor", "--copy-env"])

    assert copied.read_text() == TRANSFERS_EXAMPLE
    assert kept.read_text().startswith("ERPC_URL=https://keyed.example/abc123\n")
    out = lines(capsys)
    assert "PASS  ingestion/sources/ethereum-erc20-transfers/.env copied from .env.example" in out
    assert "PASS  ingestion/sources/ethereum-eth-balances/.env sets every required key" in out
    assert "WARN" not in "".join(line[:4] for line in out[: len(PACKAGES) + 1])


def test_doctor_copy_env_never_copies_the_root_env(repo, services, capsys):
    assert main(["doctor", "--copy-env"]) == 1
    assert not (repo / ".env").exists()
    assert "FAIL  .env is missing; copy .env.example to it" in lines(capsys)


def test_doctor_reports_missing_keys_without_values(repo, services, capsys):
    with_envs(repo)
    (repo / ".env").write_text(ROOT_ENV.replace("WAREHOUSE_USER=elt\n", ""))
    balances = repo / "ingestion" / "sources" / "ethereum-eth-balances" / ".env"
    balances.write_text("WAREHOUSE_HOST=db.internal.example\nWAREHOUSE_PASSWORD=s3cret-pw-77\nERPC_URL=\nPUSHGATEWAY_URL=\n")

    assert main(["doctor"]) == 1

    out = capsys.readouterr().out
    assert "FAIL  .env lacks WAREHOUSE_USER\n" in out
    assert "FAIL  ingestion/sources/ethereum-eth-balances/.env lacks BLOCK_NUMBER, ERPC_URL\n" in out
    assert "PASS  ingestion/sources/ethereum-erc20-transfers/.env sets every required key" in out
    for value in ("s3cret-pw-77", "root-pw-9f3a", "db.internal.example", "eth.drpc.org"):
        assert value not in out
    # Keys the schemas read with a default, left empty or out, are never missing.
    for key in ("PUSHGATEWAY_URL", "RPC_BATCH_SIZE", "LOG_LEVEL", "PORTAL_URL", "END_BLOCK", "GOOGLE_OAUTH_CLIENT_SECRET"):
        assert key not in out


def multi_chain_package(repo):
    """Adds evm-address-code, which loads one table on two chains, to the repo and its sources.json."""
    package = repo / "ingestion" / "sources" / "evm-address-code"
    package.mkdir(parents=True)
    for name in (".env.example", ".env"):
        (package / name).write_text("WAREHOUSE_HOST=localhost\nBLOCK_NUMBER=latest\n")
    entries = json.loads((repo / SOURCES_FILE).read_text())
    for chain in ("arbitrum", "base"):
        (package / "chains" / chain).mkdir(parents=True)
        (package / "chains" / chain / ".env.example").write_text("EVM_RPC_URL=http://localhost:4000/main/evm/1\nRPC_MAX_CONCURRENCY=2\n")
        entries.append({"name": chain, "table": "address_code", "package": "evm-address-code", "settings": f"chains/{chain}"})
    (repo / SOURCES_FILE).write_text(json.dumps(entries))
    return package


def test_doctor_checks_a_multi_chain_package_once_and_each_chain_against_its_example(repo, services, capsys):
    with_envs(repo)
    chains = multi_chain_package(repo) / "chains"
    (chains / "base" / ".env").write_text("EVM_RPC_URL=\nRPC_MAX_CONCURRENCY=\n")

    main(["doctor"])

    out = lines(capsys)
    assert out.count("PASS  ingestion/sources/evm-address-code/.env sets every required key") == 1
    assert (
        "PASS  ingestion/sources/evm-address-code/chains/arbitrum/.env is missing, "
        "so ingestion/sources/evm-address-code/chains/arbitrum/.env.example applies"
    ) in out
    assert "FAIL  ingestion/sources/evm-address-code/chains/base/.env leaves EVM_RPC_URL empty" in out

    # The chain's .env.example loads beneath its .env, so a .env may set only the keys it changes.
    (chains / "base" / ".env").write_text("RPC_MAX_CONCURRENCY=1\n")
    main(["doctor"])
    assert "PASS  ingestion/sources/evm-address-code/chains/base/.env sets no required key empty" in lines(capsys)


def test_doctor_root_env_may_leave_out_what_compose_and_dbt_default(repo, services, capsys):
    with_envs(repo)
    (repo / ".env").write_text("".join(
        line for line in ROOT_ENV.splitlines(keepends=True)
        if not line.startswith(("ERPC_PORT", "DSHACKLE_HEALTH_PORT", "PUSHGATEWAY_URL"))
    ))
    main(["doctor"])
    assert "PASS  .env sets every required key" in lines(capsys)

    (repo / ".env").write_text(ROOT_ENV.replace("WAREHOUSE_PORT=5432\n", ""))
    main(["doctor"])
    assert "FAIL  .env lacks WAREHOUSE_PORT" in lines(capsys)


def test_doctor_erpc_health_uses_healthcheck_path(repo, services, capsys):
    with_envs(repo)
    (repo / ".env").write_text(ROOT_ENV)
    services.statuses = {"http://localhost:4100/healthcheck": 200, "http://localhost:8082/health": 503}

    main(["doctor"])

    assert services.requested == ["http://localhost:4100/healthcheck", "http://localhost:8082/health"]
    out = lines(capsys)
    assert "PASS  erpc is healthy at http://localhost:4100/healthcheck" in out
    assert "WARN  dshackle: http://localhost:8082/health answered 503; its upstreams may still be starting" in out


def test_doctor_warns_when_nothing_answers_and_fails_on_other_statuses(repo, services, capsys):
    with_envs(repo)
    services.statuses = {"http://localhost:8082/health": 404}
    main(["doctor"])
    out = lines(capsys)
    assert "WARN  erpc: nothing answers at http://localhost:4000/healthcheck; is docker compose up?" in out
    assert "FAIL  dshackle: http://localhost:8082/health answered 404" in out


def test_doctor_ports_come_from_the_root_env_and_closed_ones_warn(repo, services, capsys):
    with_envs(repo)
    (repo / ".env").write_text(ROOT_ENV)
    services.open_ports = {5432, 4100}
    main(["doctor"])
    out = lines(capsys)
    assert "PASS  port 5432 (warehouse) is open" in out
    assert "PASS  port 4100 (erpc) is open" in out
    assert "WARN  port 4001 (erpc metrics) is closed; is docker compose up?" in out
    assert "WARN  port 3000 (dagster) is closed; is docker compose up?" in out
    assert len([line for line in out if line.startswith(("PASS  port", "WARN  port"))]) == 9


def test_doctor_warehouse_fails_when_connect_fails(repo, services, capsys):
    with_envs(repo)
    main(["doctor"])
    assert 'FAIL  warehouse: connection to server at "localhost" (127.0.0.1), port 5432 failed' in lines(capsys)


def test_doctor_warehouse_fails_naming_the_unset_settings(repo, services, monkeypatch, capsys):
    with_envs(repo)
    monkeypatch.delenv("WAREHOUSE_PASSWORD")
    monkeypatch.delenv("WAREHOUSE_DB")
    (repo / ".env").write_text("WAREHOUSE_HOST=h\n")
    main(["doctor"])
    assert "FAIL  warehouse: set WAREHOUSE_PASSWORD, WAREHOUSE_DB in .env" in lines(capsys)


def test_doctor_tool_versions_compare_against_mise_toml(repo, services, capsys):
    with_envs(repo)
    services.versions = {"node": "v22.23.4", "pnpm": "10.28.0"}
    main(["doctor"])
    out = lines(capsys)
    assert "WARN  node is 22.23.4; mise.toml pins 24" in out
    assert "WARN  pnpm is 10.28.0; mise.toml pins 10.17.0" in out
    assert "WARN  uv is not installed" in out

    services.versions = {"node": "v24.11.0", "pnpm": "10.17.0", "uv": "uv 0.9.5"}
    main(["doctor"])
    out = lines(capsys)
    assert "PASS  node 24.11.0 matches the 24 mise.toml pins" in out
    assert "PASS  pnpm 10.17.0 matches the 10.17.0 mise.toml pins" in out
    assert "PASS  uv 0.9.5 is installed" in out


def test_doctor_exits_0_when_nothing_failed(repo, services, capsys):
    with_envs(repo)
    services.all_up()
    assert main(["doctor"]) == 0
    out = lines(capsys)
    assert not [line for line in out if line.startswith(("WARN", "FAIL"))]
    assert out[-1] == f"{len(out) - 1} passed, 0 warnings, 0 failed"


def test_doctor_exits_0_with_warnings_only(repo, services, capsys):
    with_envs(repo)
    services.all_up()
    services.open_ports.discard(3000)
    assert main(["doctor"]) == 0
    assert lines(capsys)[-1].endswith(" passed, 1 warnings, 0 failed")


def test_doctor_exits_1_on_any_fail(repo, services, capsys):
    with_envs(repo)
    services.all_up()
    services.warehouse_error = "FATAL: password authentication failed"
    assert main(["doctor"]) == 1
    assert lines(capsys)[-1].endswith(" passed, 0 warnings, 1 failed")


def test_doctor_exits_2_on_a_port_that_is_not_a_number(repo, services, capsys):
    with_envs(repo)
    (repo / ".env").write_text(ROOT_ENV.replace("ERPC_PORT=4100", "ERPC_PORT=four-thousand"))
    assert main(["doctor"]) == 2
    captured = capsys.readouterr()
    assert captured.err.endswith(": error: ERPC_PORT in .env must be a port number\n")
    assert captured.err.count("\n") == 1
    assert "four-thousand" not in captured.err


def test_doctor_exits_2_without_mise_toml(repo, services, capsys):
    with_envs(repo)
    (repo / "mise.toml").unlink()
    assert main(["doctor"]) == 2
    assert capsys.readouterr().err.endswith(": error: mise.toml is missing\n")
