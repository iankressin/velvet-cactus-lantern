# Uniswap on Ethereum: notes

These notes cover the events in `protocol.yaml`. Every address, topic and block below comes from SQD Portal data or from the Uniswap pages and sources listed in `protocol.yaml`. The proof table at the end ties each event to one real log.

## Swap fields

### v2 `Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to)`

Each pair contract emits its own Swap. All four amounts are unsigned token amounts in the token's base units.

- `amount0In` and `amount1In` are what the pair received during the call. The pair computes them from its balance after the transfer, so they include the 0.3% fee.
- `amount0Out` and `amount1Out` are what the pair sent out.
- `sender` is `msg.sender` of `pair.swap`. In practice that is a router, an aggregator's executor or a bot contract, because a pair only pays out after the input has arrived, which takes a contract to do in one transaction.
- `to` is the address the pair sent the output tokens to. Routers often name an intermediate contract here, such as the next pool in a route or their own executor.

A normal swap has one non-zero In and one non-zero Out. Flash swaps can have non-zero In on both sides, so compare `amountXOut - amountXIn` rather than testing one field.

`token0` and `token1` come from `PairCreated`. The factory sorts them by address, so `token0` is the lower address.

### v3 `Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)`

Each pool contract emits its own Swap.

- `amount0` and `amount1` are signed changes to the pool's balance. A positive amount entered the pool, so the swapper paid it. A negative amount left the pool, so the swapper received it. The input amount includes the fee.
- `sender` is `msg.sender` of `pool.swap`, the contract that got the swap callback and paid the input. It is always a contract, because the pool calls back into it.
- `recipient` is the address the pool sent the output token to. Like v2 `to`, it is often a router, an executor or the next pool.
- `sqrtPriceX96`, `liquidity` and `tick` are the pool state after the swap.

### v4 `Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)`

There are no pool contracts in v4. The PoolManager singleton emits every Swap, and `id` (a `bytes32` PoolId) names the pool.

- `amount0` and `amount1` are the swapper's balance change, which is the opposite sign to v3. A negative amount is what the swapper paid in. A positive amount is what the swapper received. The NatSpec in `IPoolManager.sol` calls them "the delta of the currency0 balance of the pool", but `PoolManager.swap` credits the same `swapDelta` to `msg.sender`, and proof row 6 shows a positive `amount1` equal to the PEPE that left the PoolManager.
- `sender` is `msg.sender` of `PoolManager.swap`. It is always a contract, because the PoolManager accepts swaps only while a contract's unlock callback is running. Usually it is the contract that called `unlock`. There is no recipient field. The output goes wherever that contract later sends it with `take`.
- `fee` is the swap fee charged, in hundredths of a basis point. It can differ from the fee in `Initialize`. Proof row 6 is a pool initialized with fee 3000 whose Swap reports 3499.
- `currency0` is `0x0000000000000000000000000000000000000000` for native ETH. Native ETH legs emit no ERC-20 Transfer log. WETH pools are separate pools.

Three v4 rules break a one-to-one match between a Swap log and token Transfer logs:

1. The PoolManager emits Swap before the `afterSwap` hook runs. A hook that returns its own delta, or a `beforeSwap` hook with custom accounting, changes what the swapper pays or gets without changing the event. Check the pool's `hooks` address in `Initialize`. The zero address means no hooks. Hooked pools are common. Of the 409 v4 pools that held PEPE by block 26343500, 263 have a hooks address.
2. Tokens move only when the unlocking contract calls `settle` or `take`, and those calls move the net balance of all its swaps in the unlock. A route through two v4 pools emits two Swap logs but no Transfer for the middle token.
3. A swapper can keep its output inside the PoolManager as ERC-6909 claims. No ERC-20 Transfer leaves the PoolManager then.

A hooked pool can also fill a swap from another pool. Transaction `0x6794a887c4cecd53232ae2b888d439e4ebbb28372d74c2add08354c6ff785560` (block 26200646) shows it on pool `0xcc2bed5ca7ab0c93173ea0c894b280b42dc146671183fc2c27a6a3254e496fe3`, PEPE/WETH with hook `0xDC766448fF29B8Cd12AE12D8252762d93ecD2ac0`.

- Log 212 is a v2 Swap on the PEPE/WETH pair. Its `sender` is the hook and its `to` is the PoolManager. It sends 11946771513895702855892124 PEPE to the PoolManager.
- Log 215 is the v4 Swap for the user's trade. Its `sender` is Universal Router 2.1.2 `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` (from the v4 deployments page), and `amount0` is +11922877970867911004480773 PEPE. Log 223 moves exactly that amount from the PoolManager to `0xeDe509211873f0f23e982caDd287E69Df7D1a1aB`, which is neither `tx.from` nor `tx.to`.
- Logs 213 and 217 are v4 Swaps on the same pool with `sender` set to the hook, both amounts 0 and liquidity 0. In October 2026, 576 of this pool's 855 Swap logs have a zero PEPE amount.

So one buy appears as a v2 Swap and a v4 Swap in the same transaction. Count trades per transaction, not Swap logs across versions, and skip Swap logs whose token amount is 0.

### How these fields relate to `tx.from`

`tx.from` is the account that signed and paid gas for the transaction. Between that account and the pool there is usually at least one contract. Neither `sender` nor `to`/`recipient` reliably names the person. The proof transactions show three common cases.

- Smart account through ERC-4337 (proof row 2). `tx.from` is a bundler, `0x43370146366cfea21302962ae3a558d72bbcc487`, calling the EntryPoint `0x4337084d9e255ff0702461cf8895ce9e3b5ff108`. The EntryPoint's `UserOperationEvent` (log 1463) names the smart account `0x329CD3C0258b7Fe71964d6c5c6cDe0862f9B249f`, which sent the PEPE. The v2 Swap's `sender` and `to` are both `0x0005ea683517b3a4463bfd798c9850Ad2d586795`, an executor contract. None of the three is the user.
- Multi-swap contract (proof row 4). `tx.from` is an EOA, `0x5b43453fce04b92e190f391a83136bfbecedefd1`. It calls `0xBdb3ba9ffe392549E1f8658DD2630c141fDF47B6`, which emits 16 Swap logs in one transaction: 7 from the v4 PoolManager, 6 with the v3 Swap topic and 3 with the v2 Swap topic. That contract is the v3 Swap's `sender` and `recipient`. The pattern looks like a trading bot, but that is an inference.
- Routing contract (proof row 6). `tx.from` is `0x1b10f9ae820d77828bd0daf4974247d62431afa7`, calling `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae`. The v4 Swap's `sender` is `0xC10eE9031F2a0B84766A86B55a8D90F357910fb4`. PEPE goes from the PoolManager to that sender. The sender passes about 18.2 PEPE each to two other addresses, which look like fee takers, and the rest to `0x1231deb6...`, which passes it to `tx.from`. Here `tx.from` is the final receiver, but no Swap field names it.

## Finding every pool that trades a token

Pad the token address to 32 bytes for topic filters (`0x000000000000000000000000` followed by the 20-byte address). The token can sit on either side of a pair, so each version needs two filter objects, one per topic position.

| Version | Filter | Pool identity |
|---|---|---|
| v2 | `address = v2_factory`, `topic0 = PairCreated`, `topic1 = token` or `topic2 = token` | pair address is data word 0 |
| v3 | `address = v3_factory`, `topic0 = PoolCreated`, `topic1 = token` or `topic2 = token` | pool address is data word 1. `topic3` is the fee tier |
| v4 | `address = v4_pool_manager`, `topic0 = Initialize`, `topic2 = token` or `topic3 = token` | `id = topic1` |

Then read the Swap logs.

- v2 and v3: `address` in the list of pair or pool addresses, `topic0` = the version's Swap.
- v4: `address = v4_pool_manager`, `topic0 = Swap`, `topic1` in the list of pool ids.

Never filter Swap logs by `topic0` alone. Forks that copy Uniswap's code emit the same v2 or v3 Swap topic0 from their own pools. Only the factory events, or the CREATE2 check below, tell you a pool is Uniswap's.

The creation scan has to start at the token's deploy block and run to the end of the question's window, because anyone can create a new pool for the token at any time. Pools created inside the window count too.

Pool addresses can also be checked without the creation log. A v2 pair is the CREATE2 address from `v2_factory`, salt `keccak256(abi.encodePacked(token0, token1))` and init code hash `0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f` (from `UniswapV2Library.sol` in v2-periphery). A v3 pool is the CREATE2 address from `v3_factory`, salt `keccak256(abi.encode(token0, token1, fee))` and init code hash `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` (from `PoolAddress.sol` in v3-periphery). A v4 pool id is `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. All three formulas reproduce the proof rows below.

## Telling a buy from a sell

Let `i` be 0 if the token is `token0` (or `currency0`) and 1 if it is `token1` (or `currency1`). A buy means the token left the pool for the swapper.

| Version | Buy of the token | Sell of the token |
|---|---|---|
| v2 | `amount{i}Out > amount{i}In` | `amount{i}In > amount{i}Out` |
| v3 | `amount{i} < 0` | `amount{i} > 0` |
| v4 | `amount{i} > 0` | `amount{i} < 0` |

One transaction can buy and sell the same token. An arbitrage buys in one pool and sells in another, and a multi-hop route can pass the token through a pool without the signer ever holding it.

For PEPE (`0x6982508145454ce325ddbe47a25d4ec3d2311933`), PEPE is `token0` against WETH and USDC, because its address is lower. In native ETH v4 pools it is `currency1`, because ETH is the zero address.

## What "wallet bought token X" can mean

| Reading | Who counts | Data it needs | Where it goes wrong |
|---|---|---|---|
| Transaction sender | `tx.from` of each transaction with at least one buy Swap | Swap logs, the pool list, and `transactions.from` joined on transaction hash | Counts ERC-4337 bundlers, relayers, solvers and bot operators. Misses smart-account users entirely (proof row 2). |
| Swap recipient | v2 `to`, v3 `recipient` of each buy Swap | Swap logs and the pool list only | Often a router, an executor or the next pool in a route. In proof rows 2 and 4 the field names an executor and a multi-swap contract, not the user. v4 has no recipient, so v4 needs the Transfer logs out of the PoolManager instead. |
| Final receiver | Each address whose PEPE balance went up in a transaction with a buy Swap, after removing pools, the PoolManager and routers | Swap logs, the pool list, every PEPE Transfer log in those transactions, and a list of router and executor addresses to drop | Fee takers also receive small amounts (proof row 6 sends about 18.2 PEPE each to two other addresses). ERC-6909 claims leave no Transfer. Needs a rule for when the receiver is a contract. |

Two more choices sit on top of any reading. "Bought" can mean any buy in the month or a net gain over the month, which needs sells too. "Wallet" can mean externally owned accounts only, or smart accounts as well.

## Proof table

Each row is one log fetched from SQD Portal for `ethereum-mainnet`. All rows came through the Portal stream API with the log filter's `transactionLogs` and `transaction` options, so the rest of the transaction's logs came back too. Rows 1 and 6 were also fetched with the Portal MCP tool `portal_evm_query_logs`. Decoding used the ABI files in `abis/`, which hold the events from Uniswap's npm packages `@uniswap/v2-core@1.0.1`, `@uniswap/v3-core@1.0.1` and `@uniswap/v4-core@1.0.2`. Each `topic0` in `protocol.yaml` is the keccak-256 of the signature built from those ABIs, and Portal returned every row below under that `topic0` filter.

Token amounts are in base units. PEPE, WETH and ETH have 18 decimals.

| # | Event | Block | Transaction | Log | Decoded fields | How the decoding was confirmed |
|---|---|---|---|---|---|---|
| 1 | v2.PairCreated | 17046833 | `0x273894b35d8c30d32e1ffa22ee6aa320cc9f55f2adbba0583594ed47c031f6f6` | 244 | token0 PEPE, token1 WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, pair `0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f`, pair count 161242 | The CREATE2 formula above gives the same pair address. The transaction calls the V2Router02 from the v2 deployments page. Row 2 shows this pair's Swap amounts matching Transfers. |
| 2 | v2.Swap | 26093739 | `0xeb750ba1ca0d3d19250561dfc1fa163b042753c1cf07e4a1fa1f4d714b418d74` | 1454 | sender = to = `0x0005ea683517b3a4463bfd798c9850Ad2d586795`, amount0In 3109917065813374624992507, amount1In 0, amount0Out 0, amount1Out 4946989499112407. A sell of PEPE. | PEPE Transfer log 1450 into the pair equals amount0In. WETH Transfer log 1452 from the pair to `to` equals amount1Out. |
| 3 | v3.PoolCreated | 17083569 | `0x8bfa0fdd0bd32d40ad22c5886da8ae4b085a671a813e9e9826099da3cc449856` | 219 | token0 PEPE, token1 WETH, fee 3000, tickSpacing 60, pool `0x11950d141EcB863F01007AdD7D1A342041227b58` | The CREATE2 formula above gives the same pool address. The transaction calls the NonfungiblePositionManager from the v3 deployments page. Row 4 shows this pool's Swap amounts matching Transfers. |
| 4 | v3.Swap | 26093754 | `0x7fd3f10cb5fa331213578b92015bef72681a2fe6a8bae33b33f48ae134c035a0` | 52 | sender = recipient = `0xBdb3ba9ffe392549E1f8658DD2630c141fDF47B6`, amount0 +60703901842778745531793408, amount1 -96537242406164546, sqrtPriceX96 3163888089013300511132022, liquidity 10490809103799181309502369, tick -202576. A sell of PEPE. | PEPE Transfer log 51 into the pool equals amount0. WETH Transfer log 50 out of the pool equals minus amount1. The swap's price, 1.590e-9 WETH per PEPE, is within 0.3% of 1.0001^tick. |
| 5 | v4.Initialize | 21696324 | `0x09a586e81feefc5cfaf3dfc3b24bcaa1b362eb52e2dde6820fb1f8bea1504c43` | 169 | id `0x4d2985ed0e6f89fdfea66264f88241db024c75ec656d9b7314ccb759e27d11ca`, currency0 native ETH (zero address), currency1 PEPE, fee 3000, tickSpacing 60, hooks none, sqrtPriceX96 1162056876642332197284274096619036, tick 191877 | `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))` equals the id. The transaction calls the v4 PositionManager from the v4 deployments page. |
| 6 | v4.Swap | 26094121 | `0xeb8fba8a980d0f0f236d4b57516e419c4ea4b3930c51229643feb1fc1a6c36fc` | 279 | id from row 5, sender `0xC10eE9031F2a0B84766A86B55a8D90F357910fb4`, amount0 -367589580184782 (ETH paid), amount1 +229267731471391791625501 (PEPE received), sqrtPriceX96 1981686837244223760687296407160875, liquidity 20824203275420416362335, tick 202552, fee 3499. A buy of PEPE. | PEPE Transfer log 280 from the PoolManager to `sender` equals amount1, and the three PEPE Transfers out of `sender` (logs 281 to 283) add up to it. The ETH leg has no Transfer log. The transaction's value, 372242612845348 wei, covers the 367589580184782 wei the swap took. The swap's price, 6.237e8 PEPE per ETH, is within 0.3% of 1.0001^tick. |

The MCP tool's built-in decoder gets row 6 wrong. It prints `amount0` as 115792089237316195423570985008687907853269984665640564039457583640323549455154, which is 2^256 minus 367589580184782, because it reads `int128` as unsigned. It also prints `tick` and `fee` as raw hex. Decode signed fields with the ABI.

## Time window used for checks

Portal resolves 2026-10-01 00:00:00 UTC to block 26093737, whose timestamp is 2026-09-30 23:59:59, and 2026-11-01 00:00:00 UTC to block 26316188, whose timestamp is 2026-10-31 23:59:59. October 2026 is therefore blocks 26093738 to 26316188, both included.
