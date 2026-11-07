"""bj check: add a check the agent ran itself, such as cross_check, to an answer's answer.json.

`bj answer` writes answer.json from scratch, so a new run drops these checks: new results void them.
"""

import json
import re
from pathlib import Path

from pipeline.cli import BadInput
from pipeline.cli.question import answer_dir

NAME = re.compile(r"^[a-z][a-z0-9_]*$")
# The checks bj answer runs. A check the agent runs must not replace one of them.
ANSWER_CHECKS = ("dbt_tests", "dead_letters", "freshness", "coverage")


def run(repo_root: Path, slug: str, name: str, status: str, detail: str) -> int:
    path = answer_dir(repo_root, slug) / "answer.json"
    if not path.is_file():
        raise BadInput(f"answers/{slug}/answer.json does not exist: run `bj answer {slug}` first")
    if not NAME.match(name):
        raise BadInput(f"check name {name!r} must match {NAME.pattern}")
    if name in ANSWER_CHECKS:
        raise BadInput(f"{name} is a check bj answer runs; give the check you ran its own name, such as cross_check")
    if not detail.strip():
        raise BadInput("say what the check compared, and what it found, in <detail>")
    try:
        answer = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BadInput(f"answers/{slug}/answer.json is not valid JSON ({error}): run `bj answer {slug}` again") from None
    checks = answer.get("checks") if isinstance(answer, dict) else None
    if not isinstance(checks, list) or not all(isinstance(c, dict) and isinstance(c.get("name"), str) for c in checks):
        raise BadInput(f"answers/{slug}/answer.json has no checks list as bj answer writes it: run `bj answer {slug}` again")

    check = {"name": name, "status": status, "detail": detail.strip()}
    names = [c["name"] for c in checks]
    if name in names:
        checks[names.index(name)] = check
    else:
        checks.append(check)
    path.write_text(json.dumps(answer, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{name}: {'passed' if status == 'passed' else 'FAILED'} ({check['detail']})")
    return 0 if status == "passed" else 1
