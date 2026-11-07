"""Writes the provisioned Grafana dashboards in dashboards/. Edit this file, then run:

    python3 infra/grafana/build_dashboards.py

Grafana reloads the files within a minute. Provisioned dashboards cannot be saved from the UI.
erpc.json comes from the eRPC release instead (see infra/docker-compose.yml).
"""

import json
from pathlib import Path

PROM = {"type": "prometheus", "uid": "prometheus"}
PG = {"type": "grafana-postgresql-datasource", "uid": "warehouse"}

STATUS_COLORS = {
    "succeeded": "green", "success": "green", "pass": "green",
    "failed": "red", "error": "red", "fail": "red", "runtime error": "red",
    "warn": "orange", "skipped": "text",
}
STATUS_MAPPINGS = [{
    "type": "value",
    "options": {status: {"color": color, "index": i} for i, (status, color) in enumerate(STATUS_COLORS.items())},
}]


def thresholds(*steps):
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for v, c in steps]}


def prom(expr, legend="", instant=False):
    return {"datasource": PROM, "expr": expr, "legendFormat": legend, "instant": instant, "range": not instant}


def sql(raw, fmt="table"):
    return {"datasource": PG, "rawSql": raw, "format": fmt, "editorMode": "code", "rawQuery": True}


def override(name, **properties):
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": key.replace("__", "."), "value": value} for key, value in properties.items()]}


class Dashboard:
    """Places panels left to right in rows of 24 columns, the way Grafana's grid works."""

    def __init__(self, uid, title, description, time_from, tag, variables=(), annotations=()):
        self.uid, self.title, self.description, self.time_from, self.tag = uid, title, description, time_from, tag
        self.variables, self.annotations = list(variables), list(annotations)
        self.panels, self.x, self.y, self.line_height = [], 0, 0, 0

    def row(self, title):
        self.y += self.line_height
        self.x = self.line_height = 0
        self.panels.append({"id": len(self.panels) + 1, "type": "row", "title": title, "collapsed": False,
                            "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1}, "panels": []})
        self.y += 1

    def add(self, kind, title, description, targets, w, h, defaults=None, overrides=(), options=None):
        if self.x + w > 24:
            self.y += self.line_height
            self.x = self.line_height = 0
        datasource = targets[0]["datasource"]
        self.panels.append({
            "id": len(self.panels) + 1, "type": kind, "title": title, "description": description,
            "datasource": datasource, "gridPos": {"x": self.x, "y": self.y, "w": w, "h": h},
            "targets": [{"refId": chr(ord("A") + i), **t} for i, t in enumerate(targets)],
            "fieldConfig": {"defaults": defaults or {}, "overrides": list(overrides)},
            "options": options or {},
        })
        self.x += w
        self.line_height = max(self.line_height, h)

    def stat(self, title, description, targets, w=4, h=4, unit="short", steps=((None, "text"),),
             mappings=(), decimals=None, text_mode="value", color_mode="value", orientation="auto", fields=""):
        defaults = {"unit": unit, "thresholds": thresholds(*steps), "mappings": list(mappings),
                    "color": {"mode": "thresholds"}}
        if decimals is not None:
            defaults["decimals"] = decimals
        self.add("stat", title, description, targets, w, h, defaults, options={
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": fields, "values": False},
            "textMode": text_mode, "colorMode": color_mode, "graphMode": "none",
            "justifyMode": "auto", "orientation": orientation, "wideLayout": True,
        })

    def series(self, title, description, targets, w=12, h=8, unit="short", points=False, steps=False,
               stack=False, overrides=(), max_value=None):
        custom = {"lineInterpolation": "stepAfter" if steps else "linear", "showPoints": "always" if points else "never",
                  "pointSize": 6, "spanNulls": targets[0]["datasource"] is PG, "fillOpacity": 10,
                  "stacking": {"mode": "normal" if stack else "none", "group": "A"}}
        defaults = {"unit": unit, "custom": custom}
        if max_value is not None:
            defaults["max"] = max_value
        self.add("timeseries", title, description, targets, w, h, defaults, overrides, {
            "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "desc"},
        })

    def table(self, title, description, targets, w=24, h=8, overrides=(), sort_by=None):
        options = {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}}
        if sort_by:
            options["sortBy"] = [{"displayName": sort_by, "desc": True}]
        self.add("table", title, description, targets, w, h,
                 {"custom": {"align": "auto", "cellOptions": {"type": "auto"}, "inspect": True}},
                 [override("Status", custom__cellOptions={"type": "color-text"}, mappings=STATUS_MAPPINGS),
                  *overrides], options)

    def bars(self, title, description, targets, x_field, w=12, h=8, unit="s", overrides=()):
        self.add("barchart", title, description, targets, w, h,
                 {"unit": unit, "color": {"mode": "palette-classic"}, "custom": {"fillOpacity": 80, "lineWidth": 0}},
                 overrides, {"orientation": "horizontal", "xField": x_field, "stacking": "normal",
                             "showValue": "never", "barWidth": 0.8, "groupWidth": 0.7, "xTickLabelRotation": 0,
                             "legend": {"showLegend": False, "displayMode": "list", "placement": "bottom"},
                             "tooltip": {"mode": "single", "sort": "none"}})

    def json(self):
        return {
            "uid": self.uid, "title": self.title, "description": self.description,
            "tags": [self.tag], "editable": True, "schemaVersion": 41, "version": 1,
            "time": {"from": self.time_from, "to": "now"}, "refresh": "1m",
            "templating": {"list": self.variables}, "annotations": {"list": self.annotations},
            "panels": self.panels,
        }


def ingestion_dashboard():
    """Each source's latest run, from the metrics it pushes to the Pushgateway."""
    legend = "{{source}}.{{table}}"
    d = Dashboard("ingestion", "Ingestion", "Results of each ingestion source's runs, pushed through the Pushgateway.", "now-7d", "ingestion")
    d.stat("Last run", "Whether each source's last run succeeded.", [prom("ingestion_last_run_success", legend)],
           w=6, h=6, steps=((None, "red"), (1, "green")), text_mode="value_and_name", color_mode="background", orientation="horizontal",
           mappings=[{"type": "value", "options": {"1": {"text": "Succeeded", "color": "green", "index": 0},
                                                    "0": {"text": "Failed", "color": "red", "index": 1}}}])
    d.stat("Time since last success", "Turns orange after 25 hours, when a daily run is overdue, and red after 49 hours.",
           [prom("time() - ingestion_last_success_timestamp_seconds", legend)], w=6, h=6, unit="s", decimals=0,
           steps=((None, "green"), (90000, "orange"), (176400, "red")), text_mode="value_and_name", color_mode="background", orientation="horizontal")
    d.stat("Failed calls in the last run", "Calls that failed and wait as dead letters for the next run.",
           [prom("ingestion_last_run_failed_calls", legend)], w=6, h=6, steps=((None, "green"), (1, "orange")),
           text_mode="value_and_name", color_mode="background", orientation="horizontal")
    d.stat("Parked dead letters", "Calls that failed too often and are no longer retried. Someone has to look at them"
           " in the raw schema's _dead_letters table.", [prom('ingestion_dead_letters{state="parked"}', legend)],
           w=6, h=6, steps=((None, "green"), (1, "red")), text_mode="value_and_name", color_mode="background", orientation="horizontal")
    d.series("Records written per run", "Records each run wrote to its raw table.",
             [prom("ingestion_last_run_records_written", legend)], points=True, steps=True)
    d.series("Failed calls per run", "Calls each run queued as dead letters.",
             [prom("ingestion_last_run_failed_calls", legend)], points=True, steps=True)
    d.series("Run duration", "How long each run took.", [prom("ingestion_last_run_duration_seconds", legend)],
             unit="s", points=True, steps=True)
    d.series("Dead letters retried per run", "Calls from earlier runs that each run tried again.",
             [prom("ingestion_last_run_retried_calls", legend)], points=True, steps=True)
    d.series("Dead letters waiting", "Dead letters left after each run. Pending ones are retried next run."
             " Parked ones failed too often and wait for a person.",
             [prom("ingestion_dead_letters", "{{source}}.{{table}} {{state}}")], w=24, points=True, steps=True)
    return d


THIS_RUN_INGESTION = "coalesce(dagster_run_id, run_id::text) = ${run:sqlstring}"
THIS_RUN_DBT = "coalesce(i.dagster_run_id, i.invocation_id::text) = ${run:sqlstring}"
SECONDS = {"unit": "s", "decimals": 2}


def pipeline_dashboard():
    run_variable = {
        "type": "query", "name": "run", "label": "Run", "datasource": PG, "refresh": 2, "sort": 0,
        "includeAll": False, "multi": False, "hide": 0, "current": {}, "options": [],
        "query": "select run_key as __value, status || ', started ' || case"
                 " when now() - started_at < interval '1 hour' then extract(minute from now() - started_at)::int || ' min ago'"
                 " when now() - started_at < interval '2 days' then floor(extract(epoch from now() - started_at) / 3600)::int || ' h ago'"
                 " else extract(day from now() - started_at)::int || ' days ago' end || ', ' || left(run_key, 8) as __text"
                 " from ops.pipeline_runs where $__timeFilter(started_at) order by started_at desc",
    }
    run_variable["definition"] = run_variable["query"]
    run_annotations = {
        "name": "Pipeline runs", "enable": True, "iconColor": "rgba(87, 148, 242, 0.6)", "datasource": PG,
        "target": {"refId": "Anno", **sql(
            "select started_at as time, finished_at as timeend, status || ' run ' || left(run_key, 8) as text,"
            " status as tags from ops.pipeline_runs where $__timeFilter(started_at)")},
    }
    d = Dashboard("pipeline", "Pipeline",
                  "Every pipeline run with its ingestion and transformation steps, the warehouse it writes to,"
                  " and the eRPC proxy in front of the chains.", "now-7d", "pipeline", [run_variable], [run_annotations])

    d.row("Runs")
    d.stat("Runs", "Pipeline runs that started in the time range.",
           [sql("select count(*) from ops.pipeline_runs where $__timeFilter(started_at)")])
    d.stat("Failed runs", "Runs in the time range where a source or the dbt build failed.",
           [sql("select count(*) from ops.pipeline_runs where status = 'failed' and $__timeFilter(started_at)")],
           steps=((None, "green"), (1, "red")))
    d.stat("Last run", "How the most recent run ended.",
           [sql("select status from ops.pipeline_runs order by started_at desc limit 1")],
           mappings=STATUS_MAPPINGS, color_mode="background", fields="/^status$/")
    d.stat("Since the last successful run", "Turns orange after 25 hours, when a daily run is overdue, and red after 49.",
           [sql("select extract(epoch from now() - max(finished_at)) from ops.pipeline_runs where status = 'succeeded'")],
           unit="s", decimals=0, steps=((None, "green"), (90000, "orange"), (176400, "red")))
    d.stat("Records written", "Records all sources wrote to the raw schema in the time range.",
           [sql("select coalesce(sum(records_written), 0) from ops.pipeline_runs where $__timeFilter(started_at)")])
    d.stat("Median run duration", "From the first step's start to the last step's end.",
           [sql("select percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at))"
                " from ops.pipeline_runs where $__timeFilter(started_at)")], unit="s", decimals=1)
    d.table("Every run", "One row per Dagster run, and per source or dbt build started by hand. Click a run to"
            " show its steps below and zoom every panel to its time.",
            [sql("""select started_at as "Started", status as "Status",
  extract(epoch from finished_at - started_at) as "Duration",
  sources_failed as "Sources failed", tests_failed as "Tests failed", records_written as "Records",
  failed_calls as "Failed calls", models_built as "Models built", models_not_built as "Models not built",
  tests_passed as "Tests passed", sources as "Sources", left(dagster_run_id, 8) as "Dagster run", run_key as "Run",
  run_key, dagster_run_id,
  (extract(epoch from started_at) * 1000)::bigint - 60000 as from_ms,
  (extract(epoch from finished_at) * 1000)::bigint + 60000 as to_ms
from ops.pipeline_runs where $__timeFilter(started_at) order by started_at desc""")],
            h=10, overrides=[
                override("Duration", unit="s", decimals=1),
                *(override(name, links=[{"title": "Show this run",
                                         "url": "/d/pipeline/pipeline?var-run=${__data.fields.run_key}"
                                                "&from=${__data.fields.from_ms}&to=${__data.fields.to_ms}"}])
                  for name in ("Started", "Run")),
                override("Started", custom__width=190),
                override("Dagster run", links=[{"title": "Open the run in Dagster", "targetBlank": True,
                                                "url": "http://localhost:3000/runs/${__data.fields.dagster_run_id}"}]),
                override("Sources failed", custom__cellOptions={"type": "color-text"}, color={"mode": "thresholds"},
                         thresholds=thresholds((None, "text"), (1, "red"))),
                override("Tests failed", custom__cellOptions={"type": "color-text"}, color={"mode": "thresholds"},
                         thresholds=thresholds((None, "text"), (1, "red"))),
                *(override(name, custom__hidden=True) for name in ("run_key", "dagster_run_id", "from_ms", "to_ms")),
            ])

    d.row("Selected run")
    d.stat("Status", "The run picked in the Run menu at the top, or by clicking a run in Every run.",
           [sql("select status from ops.pipeline_runs where run_key = ${run:sqlstring}")],
           mappings=STATUS_MAPPINGS, color_mode="background", fields="/^status$/")
    d.stat("Duration", "From the first step's start to the last step's end.",
           [sql("select extract(epoch from finished_at - started_at) from ops.pipeline_runs where run_key = ${run:sqlstring}")],
           unit="s", decimals=1)
    d.stat("Records written", "Records the run's sources wrote to the raw schema.",
           [sql("select records_written from ops.pipeline_runs where run_key = ${run:sqlstring}")])
    d.stat("Failed calls", "Calls that failed in this run and wait as dead letters.",
           [sql("select failed_calls from ops.pipeline_runs where run_key = ${run:sqlstring}")],
           steps=((None, "green"), (1, "orange")))
    d.stat("Models built", "dbt models the run built.",
           [sql("select models_built from ops.pipeline_runs where run_key = ${run:sqlstring}")])
    d.stat("Tests failed", "dbt tests that failed or errored in this run.",
           [sql("select tests_failed from ops.pipeline_runs where run_key = ${run:sqlstring}")],
           steps=((None, "green"), (1, "red")))
    d.bars("Steps", "When each step ran, measured from the start of the run. dbt tests appear as one bar.",
           [sql(f"""with steps as (
  select source || '.' || table_name as step, started_at, finished_at
  from ops.ingestion_runs where {THIS_RUN_INGESTION}
  union all
  select 'dbt build', i.started_at, i.finished_at from ops.dbt_invocations i where {THIS_RUN_DBT}
  union all
  select 'dbt ' || n.name, n.started_at, n.finished_at
  from ops.dbt_node_runs n join ops.dbt_invocations i using (invocation_id)
  where {THIS_RUN_DBT} and n.resource_type <> 'test' and n.started_at is not null
  union all
  select 'dbt tests (' || count(*) || ')', min(n.started_at), max(n.finished_at)
  from ops.dbt_node_runs n join ops.dbt_invocations i using (invocation_id)
  where {THIS_RUN_DBT} and n.resource_type = 'test' and n.started_at is not null
  having count(*) > 0
)
select step as "Step", extract(epoch from started_at - min(started_at) over ()) as "Waiting",
  extract(epoch from finished_at - started_at) as "Running"
from steps order by started_at, step""")], x_field="Step", w=24, h=9,
           overrides=[override("Waiting", color={"mode": "fixed", "fixedColor": "transparent"}, custom__fillOpacity=0,
                               custom__hideFrom={"legend": True, "tooltip": True, "viz": False})])
    d.table("Ingestion", "Each source in the run. Extract is the time spent calling the chain, Load the time spent"
            " writing to the warehouse.",
            [sql(f"""select source || '.' || table_name as "Source", case when succeeded then 'succeeded' else 'failed' end as "Status",
  started_at as "Started", extract(epoch from finished_at - started_at) as "Duration",
  extract(epoch from finished_at - started_at) - load_seconds as "Extract", load_seconds as "Load",
  records_written as "Records", failed_calls as "Failed calls", retried_calls as "Retried",
  dead_letters_pending as "Pending dead letters", dead_letters_parked as "Parked dead letters", error as "Error"
from ops.ingestion_runs where {THIS_RUN_INGESTION} order by started_at""")],
            h=7, overrides=[*(override(name, **SECONDS) for name in ("Duration", "Extract", "Load")),
                            override("Source", custom__width=200), override("Started", custom__width=190),
                            override("Error", custom__width=420)])
    d.table("dbt build", "The dbt invocation of the run, and its error when it failed.",
            [sql(f"""select i.invocation_id as "Invocation", case when i.succeeded then 'succeeded' else 'failed' end as "Status",
  i.started_at as "Started", extract(epoch from i.finished_at - i.started_at) as "Duration",
  i.dbt_version as "dbt version", i.error as "Error"
from ops.dbt_invocations i where {THIS_RUN_DBT} order by i.started_at""")],
            h=4, overrides=[override("Duration", **SECONDS), override("Invocation", custom__width=300),
                            override("Started", custom__width=190)])
    d.table("dbt models and tests", "Every node the build selected. Rows written counts rows in table models;"
            " views report none. Failing rows counts the rows a test caught.",
            [sql(f"""select n.name as "Node", n.resource_type as "Type", n.status as "Status", n.started_at as "Started",
  n.execution_seconds as "Duration", n.rows_affected as "Rows written", n.failures as "Failing rows", n.message as "Message"
from ops.dbt_node_runs n join ops.dbt_invocations i using (invocation_id)
where {THIS_RUN_DBT} order by n.started_at nulls last, n.name""")],
            w=16, h=10, overrides=[override("Duration", unit="s", decimals=3), override("Node", custom__width=360),
                                   override("Started", custom__width=190)])
    d.bars("Slowest models", "The ten models that took longest to build in this run.",
           [sql(f"""select n.name as "Model", n.execution_seconds as "Duration"
from ops.dbt_node_runs n join ops.dbt_invocations i using (invocation_id)
where {THIS_RUN_DBT} and n.resource_type = 'model' order by n.execution_seconds desc limit 10""")],
           x_field="Model", w=8, h=10)

    d.row("Run history")
    d.series("Run duration", "Each pipeline run and each dbt build.",
             [sql("select started_at as time, 'pipeline run' as metric, extract(epoch from finished_at - started_at) as value"
                  " from ops.pipeline_runs where $__timeFilter(started_at) order by 1", "time_series"),
              sql("select started_at as time, 'dbt build' as metric, extract(epoch from finished_at - started_at) as value"
                  " from ops.dbt_invocations where $__timeFilter(started_at) order by 1", "time_series")],
             unit="s", points=True)
    d.series("Ingestion duration by source", "How long each source's runs took.",
             [sql("select started_at as time, source || '.' || table_name as metric,"
                  " extract(epoch from finished_at - started_at) as value from ops.ingestion_runs"
                  " where $__timeFilter(started_at) order by 1", "time_series")], unit="s", points=True)
    d.series("Records written by source", "Records each source's runs wrote to the raw schema.",
             [sql("select started_at as time, source || '.' || table_name as metric, records_written as value"
                  " from ops.ingestion_runs where $__timeFilter(started_at) order by 1", "time_series")], points=True)
    d.series("Failed calls and dead letters by source", "Failed calls in each run, and the dead letters left after it.",
             [sql("select started_at as time, source || '.' || table_name || ' failed calls' as metric, failed_calls as value"
                  " from ops.ingestion_runs where $__timeFilter(started_at) order by 1", "time_series"),
              sql("select started_at as time, source || '.' || table_name || ' dead letters' as metric,"
                  " dead_letters_pending + dead_letters_parked as value from ops.ingestion_runs"
                  " where $__timeFilter(started_at) and dead_letters_pending is not null order by 1", "time_series")],
             points=True)
    d.series("Model build time", "How long each dbt model took to build, per build.",
             [sql("select n.started_at as time, n.name as metric, n.execution_seconds as value from ops.dbt_node_runs n"
                  " where n.resource_type = 'model' and n.started_at is not null and $__timeFilter(n.started_at)"
                  " order by 1", "time_series")], unit="s", points=True)
    d.series("Rows in table models", "Rows each table model held after each build.",
             [sql("select n.started_at as time, n.name as metric, n.rows_affected as value from ops.dbt_node_runs n"
                  " where n.rows_affected is not null and $__timeFilter(n.started_at) order by 1", "time_series")],
             points=True)
    d.series("dbt test results", "Tests that passed, warned and failed in each build.",
             [sql("select started_at as time, tests_passed as passed, tests_warned as warned, tests_failed as failed"
                  " from ops.pipeline_runs where transformed and $__timeFilter(started_at) order by 1", "time_series")],
             w=24, points=True,
             overrides=[override("passed", color={"mode": "fixed", "fixedColor": "green"}),
                        override("warned", color={"mode": "fixed", "fixedColor": "orange"}),
                        override("failed", color={"mode": "fixed", "fixedColor": "red"})])

    wh = 'datname="warehouse"'
    rate = "[$__rate_interval]"
    d.row("Warehouse")
    d.stat("Database size", "Disk used by the warehouse database.", [prom(f"pg_database_size_bytes{{{wh}}}", instant=True)],
           unit="bytes")
    d.stat("Connections", "Open connections to the warehouse database.",
           [prom(f"sum(pg_stat_activity_count{{{wh}}})", instant=True)])
    d.stat("Cache hit ratio", "Share of block reads served from memory in the time range.",
           [prom(f"sum(increase(pg_stat_database_blks_hit{{{wh}}}[$__range])) / (sum(increase(pg_stat_database_blks_hit{{{wh}}}[$__range]))"
                 f" + sum(increase(pg_stat_database_blks_read{{{wh}}}[$__range])))", instant=True)],
           unit="percentunit", decimals=1, steps=((None, "red"), (0.9, "orange"), (0.99, "green")))
    d.stat("Transactions", "Transactions committed in the time range.",
           [prom(f"sum(increase(pg_stat_database_xact_commit{{{wh}}}[$__range]))", instant=True)], decimals=0)
    d.stat("Rollbacks", "Transactions rolled back in the time range.",
           [prom(f"sum(increase(pg_stat_database_xact_rollback{{{wh}}}[$__range]))", instant=True)], decimals=0)
    d.stat("Deadlocks", "Deadlocks in the time range.",
           [prom(f"sum(increase(pg_stat_database_deadlocks{{{wh}}}[$__range]))", instant=True)], decimals=0,
           steps=((None, "green"), (1, "red")))
    d.table("Tables", "Every table in the warehouse database now. Rows is Postgres's running count, which"
            " ANALYZE corrects.",
            [sql("""select schemaname as "Schema", relname as "Table", n_live_tup as "Rows", n_dead_tup as "Dead rows",
  pg_total_relation_size(relid) as "Size", seq_scan as "Sequential scans", idx_scan as "Index scans",
  n_tup_ins as "Rows inserted", n_tup_upd as "Rows updated", n_tup_del as "Rows deleted",
  greatest(last_vacuum, last_autovacuum) as "Last vacuum", greatest(last_analyze, last_autoanalyze) as "Last analyze"
from pg_stat_user_tables order by pg_total_relation_size(relid) desc""")],
            h=9, overrides=[override("Size", unit="bytes"), override("Table", custom__width=240)])
    table_legend = "{{schemaname}}.{{relname}}"
    d.series("Rows by table", "Live rows in each table.", [prom(f"pg_stat_user_tables_n_live_tup{{{wh}}}", table_legend)])
    d.series("Size by table", "Disk used by each table and its indexes.",
             [prom(f"pg_stat_user_tables_table_size_bytes{{{wh}}} + pg_stat_user_tables_index_size_bytes{{{wh}}}",
                   table_legend)], unit="bytes")
    d.series("Rows changed by table", "Rows inserted, updated and deleted per second in each table.",
             [prom(f"sum by (schemaname, relname) (rate(pg_stat_user_tables_n_tup_ins{{{wh}}}{rate})"
                   f" + rate(pg_stat_user_tables_n_tup_upd{{{wh}}}{rate}) + rate(pg_stat_user_tables_n_tup_del{{{wh}}}{rate}))",
                   table_legend)])
    d.series("Row operations", "Rows the warehouse database inserted, updated, deleted and read per second.",
             [prom(f"rate(pg_stat_database_tup_{op}{{{wh}}}{rate})", op) for op in
              ("inserted", "updated", "deleted", "fetched")])
    d.series("Transactions per second", "Commits and rollbacks.",
             [prom(f"rate(pg_stat_database_xact_commit{{{wh}}}{rate})", "commits"),
              prom(f"rate(pg_stat_database_xact_rollback{{{wh}}}{rate})", "rollbacks")])
    d.series("Connections by state", "Open connections to the warehouse database by state.",
             [prom(f"sum by (state) (pg_stat_activity_count{{{wh}}})", "{{state}}")], stack=True)
    d.series("Cache hit ratio over time", "Share of block reads served from memory.",
             [prom(f"rate(pg_stat_database_blks_hit{{{wh}}}{rate}) / (rate(pg_stat_database_blks_hit{{{wh}}}{rate})"
                   f" + rate(pg_stat_database_blks_read{{{wh}}}{rate}))", "hit ratio")], unit="percentunit", max_value=1)
    d.series("Query time by user", "Seconds per second that queries ran, from pg_stat_statements. 1 means one query"
             " running at all times.", [prom(f"sum by (user) (rate(pg_stat_statements_seconds_total{{{wh}}}{rate}))", "{{user}}")],
             unit="s")
    d.series("Sequential scans by table", "Full table reads per second. Many on a large table can mean a missing index.",
             [prom(f"rate(pg_stat_user_tables_seq_scan{{{wh}}}{rate})", table_legend)])
    d.series("Dead rows by table", "Rows that updates and deletes left behind until vacuum removes them.",
             [prom(f"pg_stat_user_tables_n_dead_tup{{{wh}}}", table_legend)])
    d.table("Queries that used the most time", "The pipeline's queries since pg_stat_statements was last reset,"
            " not limited to the time range. Leaves out the dashboard's own queries, and any statement that sets a password.",
            [sql("""select left(regexp_replace(regexp_replace(s.query, '^/\\*.*?\\*/', ''), '\\s+', ' ', 'g'), 300) as "Query",
  r.rolname as "User",
  s.calls as "Calls", s.total_exec_time as "Total time", s.mean_exec_time as "Mean time", s.max_exec_time as "Max time",
  s.rows as "Rows", s.shared_blks_hit::float / nullif(s.shared_blks_hit + s.shared_blks_read, 0) as "Cache hit ratio"
from pg_stat_statements s join pg_roles r on r.oid = s.userid join pg_database db on db.oid = s.dbid
where db.datname = current_database() and r.rolname <> 'monitor' and s.query !~* 'password'
order by s.total_exec_time desc limit 25""")],
            h=10, overrides=[override(name, unit="ms", decimals=1) for name in ("Total time", "Mean time", "Max time")]
            + [override("Cache hit ratio", unit="percentunit", decimals=1), override("Query", custom__width=620)])

    d.row("eRPC")
    received = "erpc_network_request_received_total"
    d.stat("Requests", "Requests the ingestion sources sent to eRPC in the time range.",
           [prom(f"sum(increase({received}[$__range]))", instant=True)], decimals=0)
    d.stat("Failed requests", "Requests eRPC could not answer after its retries, in the time range.",
           [prom("sum(increase(erpc_network_failed_request_total[$__range])) or vector(0)", instant=True)], decimals=0,
           steps=((None, "green"), (1, "orange")))
    d.stat("Success rate", "Share of requests eRPC answered in the time range.",
           [prom(f"sum(increase(erpc_network_successful_request_total[$__range])) / sum(increase({received}[$__range]))",
                 instant=True)], unit="percentunit", decimals=1, steps=((None, "red"), (0.95, "orange"), (0.999, "green")))
    d.stat("p95 latency", "95% of requests took less than this, in the time range.",
           [prom("histogram_quantile(0.95, sum by (le) (rate(erpc_network_request_duration_seconds_bucket[$__range])))",
                 instant=True)], unit="s", decimals=2)
    d.stat("Cache hit rate", "Share of cache lookups that eRPC answered from its cache, in the time range.",
           [prom("(sum(increase(erpc_cache_get_success_hit_total[$__range])) or vector(0))"
                 " / ((sum(increase(erpc_cache_get_success_hit_total[$__range])) or vector(0))"
                 " + sum(increase(erpc_cache_get_success_miss_total[$__range])))", instant=True)],
           unit="percentunit", decimals=1)
    d.stat("Rate limited", "Requests a rate limit held back in the time range.",
           [prom("sum(increase(erpc_rate_limits_total[$__range])) or vector(0)", instant=True)], decimals=0,
           steps=((None, "green"), (1, "orange")))
    d.series("Requests by method", "Requests per second the sources sent, by chain and RPC method.",
             [prom(f"sum by (network, category) (rate({received}{rate}))", "{{network}} {{category}}")], unit="reqps")
    d.series("Failed requests by error", "Requests per second that failed after eRPC's retries, by error.",
             [prom(f"sum by (network, error) (rate(erpc_network_failed_request_total{rate}))", "{{network}} {{error}}")],
             unit="reqps")
    d.series("Latency by chain", "Time eRPC took to answer, retries included.",
             [prom(f"histogram_quantile({q}, sum by (le, network) (rate(erpc_network_request_duration_seconds_bucket{rate})))",
                   f"{{{{network}}}} p{int(q * 100)}") for q in (0.5, 0.95)], unit="s")
    d.series("Upstream requests", "Requests per second eRPC sent to each RPC provider. Includes retries and eRPC's"
             " own polling for new blocks, which runs when no source does.",
             [prom(f"sum by (upstream) (rate(erpc_upstream_request_total{rate}))", "{{upstream}}")], unit="reqps", stack=True)
    d.series("Upstream errors", "Errors per second from each RPC provider, by error.",
             [prom(f"sum by (upstream, error) (rate(erpc_upstream_request_errors_total{rate}))", "{{upstream}} {{error}}")],
             unit="reqps")
    d.series("Upstream p95 latency", "95% of each provider's answers took less than this.",
             [prom(f"histogram_quantile(0.95, sum by (le, upstream) (rate(erpc_upstream_request_duration_seconds_bucket{rate})))",
                   "{{upstream}}")], unit="s")
    d.series("Retries", "Retries per second, by chain and reason.",
             [prom(f"sum by (network, reason) (rate(erpc_network_retry_attempt_total{rate}))", "{{network}} {{reason}}")],
             unit="reqps")
    d.series("Rate limits", "Requests per second a rate limit held back, by provider and budget.",
             [prom(f"sum by (upstream, budget) (rate(erpc_rate_limits_total{rate}))", "{{upstream}} {{budget}}")],
             unit="reqps")
    d.series("Cache lookups", "Cache hits and misses per second.",
             [prom(f"sum(rate(erpc_cache_get_success_hit_total{rate}))", "hits"),
              prom(f"sum(rate(erpc_cache_get_success_miss_total{rate}))", "misses")], unit="reqps")
    d.series("Upstream block lag", "Blocks each provider is behind the most recent block any provider reports.",
             [prom("erpc_upstream_block_head_lag", "{{network}} {{upstream}}")])
    d.add("bargauge", "Requests by provider", "Requests eRPC sent to each RPC provider in the time range.",
          [prom("sort_desc(sum by (upstream) (increase(erpc_upstream_request_total[$__range])))", "{{upstream}}",
                instant=True)], 24, 8, {"unit": "short", "decimals": 0, "color": {"mode": "palette-classic"}},
          options={"orientation": "horizontal", "displayMode": "basic", "showUnfilled": True, "valueMode": "color",
                   "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}})
    return d


if __name__ == "__main__":
    out = Path(__file__).parent / "dashboards"
    for dashboard in (ingestion_dashboard(), pipeline_dashboard()):
        (out / f"{dashboard.uid}.json").write_text(json.dumps(dashboard.json(), indent=2) + "\n")
        print(f"wrote {out / dashboard.uid}.json ({len(dashboard.panels)} panels)")
