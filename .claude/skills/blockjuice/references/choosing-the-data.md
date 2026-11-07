# State or history

Decide for each input the question needs.

1. **The protocol is unknown.** Its contracts, events and their meaning are not in the repo. Exploring a protocol is not built yet, so stop and tell the user.
2. **No view function returns it.** Use history. No contract lists an ERC-20's holders, sums a pool's volume or records who traded.
3. **It is a series over a range of blocks or time.** Use history. Reading state at every block costs far more than reading the events.
4. **It is a value at a few points in time.** Use state, with every call pinned to a block number.
   - Now, on any chain: a state read at the latest finalized block or slot.
   - A past block on an EVM chain: a state read through an archive RPC. Most free RPCs are not archive nodes.
   - A past time on Solana: history. A Solana RPC serves current state only.
   - A past time on Bitcoin: history. The Bitcoin source scans the UTXO set at the tip only.

## Rebuilding values from history

A value rebuilt from events can drift from the chain's state:

- Rebasing tokens change balances without a `Transfer`.
- Fee-on-transfer tokens move less than the event says.
- Native ETH sent by an internal call shows up only in traces, not in logs.
- Contracts made by a factory, such as Uniswap pools, need a pass that finds them first (`PoolCreated` before `Swap`).

So when a view function exists for a rebuilt value, also read that state at a few checkpoint blocks, and test that the two agree. When none exists, compare a sample with an independent query and say so in the answer.
