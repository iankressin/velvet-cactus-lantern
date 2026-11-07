# Chainlink Data Feeds: notes

These notes cover the event in `protocol.yaml`. Every address, block and value below comes from SQD Portal data, from reads of the feeds' proxies over RPC on 2026-11-06, or from the Chainlink pages and package listed in `protocol.yaml`. The proof table at the end ties the event to one real log per feed.

## AnswerUpdated fields

An aggregator emits `AnswerUpdated(current, roundId, updatedAt)` once for each round it stores.

| Field | Where | Meaning |
|---|---|---|
| `current` | topic1 | The answer: a signed integer in the feed's decimals. ETH / USD with 8 decimals reports 220971000000 for 2209.71 USD. |
| `roundId` | topic2 | The aggregator's own round counter. It goes up by one each round and starts again with each new aggregator. |
| `updatedAt` | data word 0 | When the round was stored, in Unix seconds. In every log sampled on the three chains it equals the block's timestamp. |

The log names no feed. Its address, the aggregator, is the only link to one, so a source must filter by aggregator address and dbt must map each aggregator to its feed.

## Rounds and phases

Users read a feed through its proxy. Each time Chainlink moves a feed to a new aggregator, the proxy's `phaseId` goes up by one, and `phaseAggregators(phaseId)` names the new aggregator. The proxy reports rounds as

```
proxy round id = phaseId << 64 | aggregator round id
```

so round ids stay unique across aggregators. `proxy.getRoundData(proxy round id)` returns the answer and `updatedAt` of the matching AnswerUpdated log. Every row of the proof table checks this.

Every round has a log. Over a day of each feed below, the number of AnswerUpdated logs equalled the span of their round ids, with no gaps.

## Finding a feed's aggregators for a window

1. Find the feed in the chain's directory (`feed_directory` in `protocol.yaml`). Note its `proxyAddress`, its `contractAddress` (the current aggregator), its `decimals` and its `heartbeat`. A long-standing proxy can also appear as another entry's `secondaryProxyAddress` (see Traps).
2. Read `phaseId()` and `phaseAggregators(1..phaseId)` on the proxy. That lists every aggregator the feed has used.
3. Read `aggregator()` on the proxy at the window's first block. If it is not the current aggregator, the window crosses a phase change, and both aggregators belong in the source's list. Block-pinned reads need an archive RPC. Without one, scan Portal for AnswerUpdated from every phase's aggregator around the window's first block: the one that logs rounds there is the live one.

The feeds the sources load, and how each window start was checked:

| Chain | Feed | Proxy | Phase | Aggregator | Decimals | Heartbeat (s) | Live at the first block of 2026-10-01 |
|---|---|---|---|---|---|---|---|
| ethereum | ETH / USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 7 | `0x7d4E742018fb52E48b08BE73d041C18B21de6Fb5` | 8 | 3600 | `aggregator()` at block 26093738 |
| ethereum | BTC / USD | `0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c` | 7 | `0x4a3411ac2948B33c69666B35cc6d055B27Ea84f1` | 8 | 3600 | `aggregator()` at block 26093738 |
| ethereum | UNI / USD | `0x553303d460EE0afB37EdFf9bE42922D8FF63220e` | 7 | `0xdEf8C51d7c1040637A198efFc39613865B32EA51` | 8 | 3600 | `aggregator()` at block 26093738 |
| arbitrum | ETH / USD | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | 2 | `0xD827123D014578C965F6c9d87A641ec05FaA5501` | 8 | 1755 | Portal: logs from 30 rounds in the 20,000 blocks before 510496864; none from phase 1 |
| arbitrum | BTC / USD | `0x6ce185860a4963106506C203335A2910413708e9` | 2 | `0xA8c2ad8Fc02733d758C0585478cdf6C53d6c9cB8` | 8 | 1755 | Portal: 21 rounds before 510496864; none from phase 1 |
| arbitrum | UNI / USD | `0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720` | 2 | `0x116AF422654D98d680029181f66A11D9cbED6bEC` | 8 | 86400 | Portal: 21 rounds before 510496864; none from phase 1 |
| base | ETH / USD | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | 3 | `0x05c84a58FE042275b37db038bAAcD15F410c7bB0` | 8 | 1200 | `aggregator()` at block 52011727 |
| base | BTC / USD | `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` | 3 | `0xe5ec87a39445b8D5b751b116802A53C5ae7e9Df1` | 8 | 1200 | `aggregator()` at block 52011727 |

Decimals come from each proxy's `decimals()`, and the feed names from its `description()`. Heartbeats come from the directory.

## Traps

- One pair can have several feeds. The directory lists, for example, `eth-usd`, `eth-usd-svr`, `eth-usd-shared-svr` and `eth-usd-cre-backup` on Arbitrum, each with its own proxy and aggregator. Pick one feed per pair and say which.
- SVR feeds have a primary proxy and a `secondaryProxyAddress` that read the same aggregator. On Base the long-standing ETH / USD and BTC / USD proxies above are no longer entries of their own: they are the `secondaryProxyAddress` of `eth-usd-shared-svr-2` and `btc-usd-shared-svr-2`. Search both fields for a known proxy.
- Decimals differ between feeds of one pair. Arbitrum's `eth-usd` has 8 and its `eth-usd-shared-svr` has 18. Scale each feed by its own decimals.
- `cre-backup` feeds point at DataFeedsCache. It emits AnswerUpdated for many feeds with no feed in the log; its `DecimalReportUpdated(dataId, ...)` names the feed. These notes do not cover it.
- The L2 sequencer uptime feeds emit AnswerUpdated with 0 or 1 as the answer. Filtering by aggregator keeps them out.
- The heartbeat is the most time the network lets pass between rounds, but the round lands a little later. Ethereum ETH / USD's longest gap over a day was 3672 s against its 3600 s heartbeat.
- `phaseAggregators(2)` on Ethereum UNI / USD returns the proxy's own address. A list of aggregators built from the proxy's phases is not always a list of aggregators.

## Proof table

Each log was fetched from Portal and decoded with `abis/aggregator.json`. The independent check reads `getRoundData(phaseId << 64 | roundId)` on the feed's proxy, which returned the same answer and `updatedAt` in every row.

| # | Chain | Feed | Block | Transaction | Log | `current` | `roundId` | `updatedAt` |
|---|---|---|---|---|---|---|---|---|
| 1 | ethereum | ETH / USD | 26356594 | `0x1027176b680349db35cc311d81e5cbc030ce465a6424baf2aef1da95368611ef` | 572 | 220971000000 | 35420 | 1793977547 |
| 2 | ethereum | BTC / USD | 26356592 | `0x625e7b14484751e20c5b88478712f4783f79cea6e4da624179d975d25131fc87` | 1407 | 7491944487991 | 25783 | 1793977523 |
| 3 | ethereum | UNI / USD | 26356592 | `0x1cd8f305d1028199680bb0b28ada1d68a9c4728f80852e66bd5c3455f3e79b4d` | 980 | 697007592 | 27471 | 1793977523 |
| 4 | arbitrum | ETH / USD | 521823614 | `0x00b320a17f485713d7782a61dbef2afd84fc7aaddc10c5e2a378b1921ec2c553` | 2 | 221943506752 | 152162 | 1793977397 |
| 5 | arbitrum | BTC / USD | 521824045 | `0x2568ea65ed3f4efefea47127a68536b59d4b35935a1aec460e99ef3ffc58ed9a` | 2 | 7502901065071 | 97655 | 1793977508 |
| 6 | arbitrum | UNI / USD | 521823628 | `0x17ddb4b0e274f98eae56f7a5ac009fecfcc32d21287c8faa0dbeb9994a0f76e9` | 5 | 698036283 | 82693 | 1793977401 |
| 7 | base | ETH / USD | 53935095 | `0x36f198aec2ba13876c05722ec23d0f3cb029e4b34f49bc0bbe45c5d198be9b16` | 55 | 221974518546 | 12276 | 1793977394 |
| 8 | base | BTC / USD | 53935242 | `0xb8c8ad32f30715ae465471cf3c18b30d1d072fe418a151c7d8a6c5446073543d` | 35 | 7518162900000 | 14233 | 1793977424 |
