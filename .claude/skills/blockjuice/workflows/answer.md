# Answer a question

Each answer lives in `answers/<slug>/`. Pick a short slug that names the question, such as `tracked-wallets-eth`. If the folder exists, you are refreshing that answer: keep its `question.yaml` unless the user changed the question.

## 1. Scope

Write `answers/<slug>/question.yaml` in the format of [../references/question-spec.md](../references/question-spec.md).

- Define every word that could be counted two ways, such as "bought", "holder", "active" or "wallet". Pick the most literal reading, write it under `definitions`, and list the readings you passed over under `alternatives`.
- Resolve every token, contract and wallet to an address on its chain. Take addresses from the repo (the `addresses.json` files, existing models) or from the user. Never use an address from memory alone.
- When the repo does not hold an address, ask the user before any other work. Ask in one message, listing the candidates you can see: several tokens share a symbol, a token has older versions or migrated contracts, a bridged token has its own address on each chain, and a protocol has several versions. Do not search the web or wikis to pick one yourself; the user knows which they mean, and a wrong pick costs every step after it.
- When the question names a past time, turn it into blocks with `bj blocks <chain> <from> <to>` for each chain it covers, and record them under `window` ([../references/question-spec.md](../references/question-spec.md)). It reads EVM chains from Portal; an unknown chain name prints the ones it knows.
- Choose `state` or `history` for each input with [../references/choosing-the-data.md](../references/choosing-the-data.md).

## 2. Find the data

Look for marts that already hold each input, in `transformation/models/marts/*/`. Read a mart's SQL and its `_<pipeline>__models.yml` before trusting its name.

- Every input is in a mart: go to step 3.
- An input needs history: follow [history-source.md](history-source.md). `bj coverage` says whether a source has already loaded the window.
- An input needs state that no source reads: follow [state-source.md](state-source.md), then [new-pipeline.md](new-pipeline.md).
- The sources hold the data but no mart shapes it the way the question needs: follow [new-pipeline.md](new-pipeline.md).

Before you build a source or a pipeline, show the user the definitions, window and inputs from `question.yaml`, and wait for a go. When existing marts answer the question, do not stop to ask.

## 3. Write the analysis

Write `transformation/analyses/<name>.sql`, where `<name>` is the slug with `_` for `-`.

- Select from marts with `{{ ref() }}`, never from staging or raw tables.
- Put the headline in the first analysis as one row and one column. `bj` records that cell as the answer's value.
- Put a breakdown in a second analysis, `<name>_by_<thing>.sql`, and list both under `analyses` in `question.yaml`.
- Convert base units in SQL (wei to ETH, satoshis to BTC, token units by decimals) and name the unit in the column, such as `eth`. Take an ERC-20 token's decimals from the `tokens` mart, joined on `chain` and `token`. A token missing there needs its address in `evm-erc20-metadata`'s `chains/<chain>/addresses.json`.

## 4. Run and check

```sh
uv run --project orchestration bj answer <slug>
```

It answers from the data already in the warehouse. It writes `results/<analysis>.csv` and `answer.json`, and exits 1 when a check fails. The `freshness` detail says when each input last loaded. [../references/checks.md](../references/checks.md) says what each failure means and what to do. Ship an answer with a failed check only when the user agrees, and say so in the answer.

When an input is history, cross-check one number once the checks pass. Count the same thing over the same blocks and filter with the Portal MCP, which reads Portal directly, without Pipes or the warehouse. Record it with `bj check <slug> cross_check passed "<what you compared, and both numbers>"`, or `failed` when they differ, and find out why before you write the answer.

## 5. Load newer data, only when needed

Run the pipeline only when `freshness` fails, a result is empty that should not be, or the user asks for data newer than the last load:

```sh
uv run --project orchestration bj run <pipeline>
```

Then rerun step 4. A failed run leaves the last good load in place, so it never means the warehouse is empty. Read the error it prints, answer from the last load, and say how old that load is. Each source reads its own `ingestion/sources/<package>/.env`. Copy its `.env.example` when that file is missing, and tell the user which values to check.

## 6. Write the answer

Write `answers/<slug>/answer.md`:

1. The answer in one sentence, with the number and its unit.
2. How it was counted: the definitions in plain words.
3. The data: chains, blocks or times, and when each input last loaded, from `answer.json`.
4. Caveats: the alternatives that would change the number, and any check that failed.

Copy numbers from `answer.json` and the CSVs; never retype or round them differently. Then give the user the answer in a sentence, link the folder, and offer a report ([report.md](report.md)).
