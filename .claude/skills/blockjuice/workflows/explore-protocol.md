# Explore a protocol

Write the protocol's catalog entry before any source reads it. `catalog/protocols/uniswap/` is the example to copy. Every address, block, topic and field meaning in the entry comes from chain data or an authoritative page, never from memory.

## The entry

- `protocol.yaml`: the docs you read, each contract per chain with its address, deploy block and how you confirmed it, and each event with what emits it, its full signature, its topic0 and its ABI file. Key events by version, as `v3.Swap`: each version becomes its own source and raw table later, per [../references/layers.md](../references/layers.md).
- `abis/`: event ABIs only.
- `NOTES.md`: what each field means, sign conventions, how the actors (`sender`, `recipient`, `tx.from`) relate, how to find every contract or pool that involves a given token, the readings of the question's words that the data can and cannot tell apart, and a proof table with one real log per event.

## Steps

1. Pin the window and the names. Use the Portal MCP one call at a time:
   - `portal_debug_resolve_time_to_block` for both edges of the window. It returns each edge block's timestamp, so you can say whether the window includes it.
   - `portal_resolve_entity` for a token symbol. Several tokens can share one symbol: when the repo does not say which one the question means, ask the user, per [answer.md](answer.md). Confirm its deploy block with `portal_evm_get_contract_deployment`.
2. Take contract addresses from the protocol's official deployment pages, and each deploy block from `portal_evm_get_contract_deployment`.
3. Take event ABIs from the protocol's published build artifacts, such as its npm packages, and compute topic0 from them with a script.
4. Prove each event on one real log. Fetch the whole transaction through Portal, decode it with your ABI, and confirm the fields against something independent: the token Transfer logs in the same transaction, a recomputed address or id, or an explorer page. Add a row to the proof table.
5. Commit the entry, then build the source with [history-source.md](history-source.md). Its step 2 estimates the load.

## Traps

- Forks reuse the original's topic0 (every Uniswap v2 and v3 fork emits the same Swap). Filter logs by the protocol's own contracts or pools, never by topic0 alone.
- Source comments can be wrong. Uniswap v4's NatSpec describes the Swap sign backwards; the proof against Transfer logs settles it.
- The Portal MCP's inline decoder shows a negative int128 as 2^256 minus the value, and some integers as hex. Decode with the ABI.
- Large MCP log queries time out, and with transaction logs included, `limit` counts the expanded logs. Keep each query to a few thousand blocks and run them one at a time, since Portal answers HTTP 529 when busy. Do not write scripts to scan or count long ranges.
