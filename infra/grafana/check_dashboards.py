"""Runs every panel and annotation query of the provisioned dashboards through Grafana's API, and
reports the panels whose queries fail or return nothing. Exits 1 when a query fails.

    python3 infra/grafana/check_dashboards.py [--grafana http://localhost:3001] [--hours 24]

A variable takes its first value, or its All value when it has one. An empty panel is not an
error: some only fill once eRPC or a run sees what they count.
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

DASHBOARDS = Path(__file__).parent / "dashboards"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grafana", default="http://localhost:3001")
    parser.add_argument("--hours", type=float, default=24)
    args = parser.parse_args()
    now = int(time.time() * 1000)
    window = {"from": str(now - int(args.hours * 3600_000)), "to": str(now)}

    def query(target: dict, datasource: dict) -> dict:
        body = {**window, "queries": [{"refId": "A", "datasource": datasource, "intervalMs": 15000,
                                       "maxDataPoints": 500, **target}]}
        request = urllib.request.Request(args.grafana + "/api/ds/query", data=json.dumps(body).encode(),
                                         headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return json.load(response)["results"]["A"]
        except urllib.error.HTTPError as error:
            return json.load(error).get("results", {}).get("A", {"error": f"HTTP {error.code}"})

    with urllib.request.urlopen(f"{args.grafana}/api/frontend/settings") as response:
        datasources = json.load(response)["datasources"]
    default_datasource = next(d for d in datasources.values() if d.get("isDefault"))

    def label_values(datasource_uid: str, selector: str, label: str) -> list:
        params = urllib.parse.urlencode({"match[]": selector} if selector else {})
        url = f"{args.grafana}/api/datasources/proxy/uid/{datasource_uid}/api/v1/label/{label}/values?{params}"
        with urllib.request.urlopen(url) as response:
            return json.load(response)["data"]

    failed = False
    for path in sorted(DASHBOARDS.glob("*.json")):
        uid = json.loads(path.read_text())["uid"]
        with urllib.request.urlopen(f"{args.grafana}/api/dashboards/uid/{uid}") as response:
            dashboard = json.load(response)["dashboard"]

        values = {}
        for variable in dashboard.get("templating", {}).get("list", []):
            if variable.get("type") == "datasource":
                matching = [d for d in datasources.values() if d["type"] == variable["query"]]
                values[variable["name"]] = min(matching, key=lambda d: not d.get("isDefault"))["uid"]
            elif variable.get("type") == "interval":
                values[variable["name"]] = variable["current"]["value"]
            elif variable.get("includeAll"):
                values[variable["name"]] = variable.get("allValue") or ".*"
            elif variable.get("type") == "query":
                text = variable["query"]["query"] if isinstance(variable["query"], dict) else variable["query"]
                prometheus = re.fullmatch(r"label_values\((?:(.*),\s*)?(\w+)\)", text.strip())
                if prometheus:
                    datasource = variable.get("datasource") or default_datasource
                    found = label_values(datasource["uid"], prometheus.group(1), prometheus.group(2))
                    values[variable["name"]] = found[0] if found else ""
                    continue
                result = query({"rawSql": text, "format": "table"}, variable["datasource"])
                frames = result.get("frames", [])
                fields = frames[0]["schema"]["fields"] if frames else []
                column = next((i for i, f in enumerate(fields) if f["name"] == "__value"), 0)
                rows = frames[0]["data"]["values"][column] if frames and frames[0]["data"]["values"] else []
                values[variable["name"]] = rows[0] if rows else ""

        def expand(text: str) -> str:
            def substitute(match: re.Match) -> str:
                name, form = match.group(1) or match.group(3), match.group(2)
                if name not in values:
                    return match.group(0)
                value = str(values[name])
                return "'" + value.replace("'", "''") + "'" if form == ":sqlstring" else value
            return re.sub(r"\$\{(\w+)(:\w+)?\}|\$(\w+)", substitute, text)

        checks = []
        panels = list(dashboard["panels"])
        while panels:
            panel = panels.pop(0)
            panels.extend(panel.get("panels", []))
            for target in panel.get("targets", []):
                checks.append((panel["title"], target, target.get("datasource") or panel.get("datasource")
                               or {"type": default_datasource["type"], "uid": default_datasource["uid"]}))
        for annotation in dashboard.get("annotations", {}).get("list", []):
            if "target" in annotation:
                checks.append((f"annotation: {annotation['name']}", annotation["target"], annotation["datasource"]))

        with_data, empty, errors = 0, [], []
        for title, target, datasource in checks:
            if "expr" in target:
                spec = {"expr": expand(target["expr"]), "range": not target.get("instant"),
                        "instant": bool(target.get("instant"))}
            elif "rawSql" in target:
                spec = {"rawSql": expand(target["rawSql"]), "format": target.get("format", "table")}
            else:
                continue
            result = query(spec, {**datasource, "uid": expand(datasource["uid"])})
            if result.get("error"):
                errors.append(f"{title}: {result['error'][:300]}")
            elif any(any(len(column) for column in frame.get("data", {}).get("values", []))
                     for frame in result.get("frames", [])):
                with_data += 1
            else:
                empty.append(title)

        print(f"{uid}: {len(checks)} queries, {with_data} with data, {len(empty)} empty, {len(errors)} failed")
        for title in empty:
            print(f"  empty   {title}")
        for line in errors:
            print(f"  FAILED  {line}")
        failed = failed or bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
