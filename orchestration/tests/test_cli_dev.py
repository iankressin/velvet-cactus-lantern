import os
from pathlib import Path

import pytest

from pipeline.cli import main
from pipeline.cli.doctor import DAGSTER_PORT
from test_cli_doctor import Services
from test_cli_install import NEXT, PNPM, Tools, make_repo, without_root_settings

UP = "docker compose up -d"


class Execed(Exception):
    pass


@pytest.fixture
def repo(tmp_path, monkeypatch):
    make_repo(tmp_path)
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    # monkeypatch puts back the working directory that dev changes.
    monkeypatch.chdir(tmp_path)
    with without_root_settings():
        yield tmp_path


@pytest.fixture
def services(monkeypatch):
    services = Services(monkeypatch)
    services.all_up()
    services.open_ports.discard(DAGSTER_PORT)
    return services


@pytest.fixture
def tools(services, monkeypatch):
    return Tools(monkeypatch)


@pytest.fixture
def execs(monkeypatch):
    calls = []

    def fake_execvp(file, args):
        calls.append((file, args, Path.cwd()))
        raise Execed

    monkeypatch.setattr(os, "execvp", fake_execvp)
    return calls


def test_installs_starts_the_stack_then_execs_dagster_dev_from_orchestration(repo, tools, execs, capsys):
    with pytest.raises(Execed):
        main(["dev"])

    assert tools.ran == [
        (PNPM, repo / "ingestion"),
        ("dbt parse", repo / "transformation"),
        (UP, repo),
    ]
    assert execs == [("dagster", ["dagster", "dev"], (repo / "orchestration").resolve())]
    out = capsys.readouterr().out
    assert "PASS  warehouse answers" in out
    assert NEXT not in out


def test_a_failed_compose_up_exits_1_and_never_starts_dagster(repo, tools, execs, capsys):
    tools.failing[UP] = (1, "service \"warehouse-init\" didn't complete successfully: exit 3\n")

    assert main(["dev"]) == 1

    assert execs == []
    assert tools.ran[-1] == (UP, repo)
    out = capsys.readouterr().out
    assert f"`{UP}` exited with code 1:\nservice \"warehouse-init\" didn't complete successfully: exit 3" in out


def test_a_doctor_fail_exits_1_and_never_starts_dagster(repo, tools, services, execs, capsys):
    services.warehouse_error = "FATAL: password authentication failed"

    assert main(["dev"]) == 1

    assert execs == []
    out = capsys.readouterr().out
    assert "FAIL  warehouse: FATAL: password authentication failed" in out
    assert "dagster dev did not start" in out


def test_dev_checks_leave_out_dagster_port_and_doctor_keeps_it(repo, tools, execs, capsys):
    with pytest.raises(Execed):
        main(["dev"])
    out = capsys.readouterr().out
    assert "PASS  port 5432 (warehouse) is open" in out
    assert "(dagster)" not in out

    main(["doctor"])
    assert "WARN  port 3000 (dagster) is closed; is docker compose up?" in capsys.readouterr().out.splitlines()


def test_port_3000_in_use_exits_2_before_install_or_compose(repo, tools, services, execs, capsys):
    services.open_ports.add(DAGSTER_PORT)

    assert main(["dev"]) == 2

    assert "port 3000 is in use" in capsys.readouterr().err
    assert tools.ran == []
    assert not (repo / ".env").exists()
    assert execs == []


def test_missing_docker_exits_2_naming_docker(repo, tools, execs, capsys):
    tools.missing = {"docker"}

    assert main(["dev"]) == 2

    err = capsys.readouterr().err
    assert "docker is not on PATH" in err
    assert err.count("\n") == 1
    assert execs == []
