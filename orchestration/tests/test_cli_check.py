import json

import pytest

from pipeline.cli import main

CHECKS = [
    {"name": "dbt_tests", "status": "passed", "detail": "54 passed"},
    {"name": "coverage", "status": "passed", "detail": "ethereum.erc20_transfers (loaded 100-180) covers blocks 100-180 and the filter"},
]


@pytest.fixture
def answered(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    folder = tmp_path / "answers" / "usdc-flows"
    folder.mkdir(parents=True)
    (folder / "answer.json").write_text(json.dumps({"question": "How much USDC moved?", "value": "12", "checks": CHECKS}, indent=2) + "\n")
    return folder / "answer.json"


def checks(path):
    return json.loads(path.read_text())["checks"]


def test_a_passed_check_is_added_after_the_others_and_exits_0(answered, capsys):
    assert main(["check", "usdc-flows", "cross_check", "passed", "inflow", "matches", "Portal:", "12"]) == 0
    assert checks(answered) == [*CHECKS, {"name": "cross_check", "status": "passed", "detail": "inflow matches Portal: 12"}]
    assert json.loads(answered.read_text())["value"] == "12"
    assert capsys.readouterr().out == "cross_check: passed (inflow matches Portal: 12)\n"


def test_a_failed_check_exits_1(answered, capsys):
    assert main(["check", "usdc-flows", "cross_check", "failed", "Portal says 13"]) == 1
    assert checks(answered)[-1] == {"name": "cross_check", "status": "failed", "detail": "Portal says 13"}
    assert "cross_check: FAILED (Portal says 13)" in capsys.readouterr().out


def test_a_check_with_the_same_name_is_replaced_in_place(answered):
    main(["check", "usdc-flows", "cross_check", "failed", "Portal says 13"])
    main(["check", "usdc-flows", "sample", "passed", "10 of 10 rows match"])
    assert main(["check", "usdc-flows", "cross_check", "passed", "Portal says 12"]) == 0
    assert [(c["name"], c["detail"]) for c in checks(answered)[2:]] == [
        ("cross_check", "Portal says 12"),
        ("sample", "10 of 10 rows match"),
    ]


@pytest.mark.parametrize("name", ["dbt_tests", "dead_letters", "freshness", "coverage"])
def test_a_check_bj_answer_runs_cannot_be_replaced(answered, capsys, name):
    before = answered.read_text()
    assert main(["check", "usdc-flows", name, "passed", "looks fine"]) == 2
    assert f"{name} is a check bj answer runs" in capsys.readouterr().err
    assert answered.read_text() == before


def test_without_answer_json_exits_2(answered, capsys):
    answered.unlink()
    assert main(["check", "usdc-flows", "cross_check", "passed", "x"]) == 2
    assert "answers/usdc-flows/answer.json does not exist: run `bj answer usdc-flows` first" in capsys.readouterr().err
    assert main(["check", "no-such-answer", "cross_check", "passed", "x"]) == 2


@pytest.mark.parametrize(
    "text, error",
    [
        ("{", "answers/usdc-flows/answer.json is not valid JSON"),
        ("[]", "answers/usdc-flows/answer.json has no checks list"),
        ('{"question": "How much USDC moved?"}', "answers/usdc-flows/answer.json has no checks list"),
        ('{"checks": {"dbt_tests": "passed"}}', "answers/usdc-flows/answer.json has no checks list"),
        ('{"checks": ["dbt_tests"]}', "answers/usdc-flows/answer.json has no checks list"),
    ],
)
def test_answer_json_bj_answer_did_not_write_exits_2_with_one_line(answered, capsys, text, error):
    answered.write_text(text)
    assert main(["check", "usdc-flows", "cross_check", "passed", "x"]) == 2
    err = capsys.readouterr().err
    assert error in err and err.count("\n") == 1
    assert answered.read_text() == text


@pytest.mark.parametrize("name, detail", [("Cross-Check", "x"), ("cross_check", " ")])
def test_a_bad_name_or_an_empty_detail_exits_2(answered, name, detail):
    assert main(["check", "usdc-flows", name, "passed", detail]) == 2
    assert checks(answered) == CHECKS


def test_a_status_other_than_passed_or_failed_is_refused(answered):
    with pytest.raises(SystemExit) as raised:
        main(["check", "usdc-flows", "cross_check", "ok", "x"])
    assert raised.value.code == 2
    assert checks(answered) == CHECKS
