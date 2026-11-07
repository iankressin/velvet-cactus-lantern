import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
INFRA = REPO_ROOT / "infra"
ALERTS = INFRA / "prometheus" / "alerts.yml"
METRICS_TS = REPO_ROOT / "ingestion" / "lib" / "src" / "run" / "metrics.ts"


def rules() -> list[dict]:
    return [rule for group in yaml.safe_load(ALERTS.read_text())["groups"] for rule in group["rules"]]


@pytest.mark.parametrize("rule", rules(), ids=lambda rule: rule["alert"])
def test_every_alert_rule_has_an_expr_a_for_a_severity_and_both_annotations(rule):
    assert rule["expr"].strip()
    assert re.fullmatch(r"\d+[smh]", str(rule["for"]))
    assert rule["labels"]["severity"] in ("warning", "critical")
    assert rule["annotations"]["summary"].strip()
    assert rule["annotations"]["description"].strip()


def test_alert_rule_names_are_unique():
    names = [rule["alert"] for rule in rules()]
    assert len(names) == len(set(names))


def test_ingestion_metrics_in_alert_rules_are_the_ones_each_run_pushes():
    pushed = set(re.findall(r'"(ingestion_[a-z_]+)"', METRICS_TS.read_text()))
    used = {name for rule in rules() for name in re.findall(r"ingestion_[a-z_]+", rule["expr"])}
    assert used
    assert used <= pushed


def test_prometheus_loads_the_alert_rules_that_compose_mounts():
    prometheus = yaml.safe_load((INFRA / "prometheus" / "prometheus.yml").read_text())
    assert prometheus["rule_files"] == ["alerts.yml"]
    compose = yaml.safe_load((INFRA / "docker-compose.yml").read_text())
    assert "./prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro" in compose["services"]["prometheus"]["volumes"]
