# ELT pipeline

Sources extract wallet balances and other chain data into the warehouse, dbt builds models from them, and Dagster schedules both.

## Language

### Ingestion

**Source**:
A package that reads one kind of data from one origin and fills one raw table.
_Avoid_: connector, extractor, job

**Stream source**:
A source that reads blocks in order through a Pipes stream instead of making calls. Each run resumes after its cursor. It makes no calls, so it has no dead letters: an error fails the run, and the next run resumes after the last batch that committed.
_Avoid_: indexer, pipe

**Call**:
One request a source makes for data, described well enough to make again in a later run.
_Avoid_: request, query

**Record**:
One row a call produced, keyed so that a rerun replaces it instead of adding another.
_Avoid_: row, item

**Batch**:
The records and failed calls that a source hands over together.
_Avoid_: chunk, page

**Run**:
One execution of one source, from picking up its retries to recording its outcome.
_Avoid_: job, execution

### Warehouse

**Warehouse**:
The database that holds the raw tables, the dead letters and the run log, and in which dbt builds its models.
_Avoid_: target, database, DB

**Cursor**:
The last block a stream source loaded. Pipes keeps it in the warehouse's `_sync` table, saved with the batch it ends.
_Avoid_: offset, checkpoint

**Raw table**:
The warehouse table one source fills, which dbt reads as a source.
_Avoid_: target table, landing table

**Dead letter**:
A failed call, kept in the warehouse so a later run can make it again. Only a call source has them; a stream source makes no calls.
_Avoid_: retry queue item, failed job

**Pending dead letter**:
A dead letter that the next run retries.

**Parked dead letter**:
A dead letter that no run retries, because it failed too many times or no longer matches what its source accepts as a call. It waits for a person.
_Avoid_: dropped, abandoned

**Run log**:
The warehouse's record of every run and its outcome.
_Avoid_: run history, audit log

### Transformation

**Mart**:
A dbt model that holds one kind of fact for every chain and asset it covers, built for many questions, not one.
_Avoid_: report table, output

**Pipeline**:
The marts in one `models/marts/<pipeline>/` folder and everything upstream of them, run as one Dagster job on one schedule.
_Avoid_: DAG, workflow

### Answers

**Answer**:
A folder in `answers/` that holds one question, how it was counted, the result and its reports.
_Avoid_: study, question folder

**Input**:
One kind of data an answer needs, read either as state or as history.

**State**:
Values that a view function or RPC method returns at one block.
_Avoid_: snapshot

**History**:
Events, transfers or traces over a range of blocks, rebuilt into values in dbt.
_Avoid_: backfill (that is the run that loads history)

**Coverage**:
The blocks a history source has loaded, from its START_BLOCK to the cursor Pipes keeps, for the addresses in its addresses.json.
_Avoid_: backfill range, sync range

**Analysis**:
A dbt analysis that selects one result from marts for one answer. Its first row and column can be the answer's value.
_Avoid_: query, report

**Check**:
A test that `bj answer` runs on an answer's inputs before the answer ships. It passes or fails.
_Avoid_: validation
