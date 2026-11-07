# Arbitrum One token bridge: notes

These notes cover the L2 side of Arbitrum One's canonical token bridge, for any ERC-20 token. Every address, topic and block below comes from SQD Portal data, from the Arbitrum docs pages in `protocol.yaml`, from read calls to the Arbitrum and Ethereum public RPCs, or from the contract sources in the npm packages `@arbitrum/token-bridge-contracts@1.2.5` and `@arbitrum/nitro-contracts@1.1.1`. The proof table at the end ties each event to one real log.

A token crosses this bridge by lock, mint and burn. A deposit locks the token in an L1 gateway on Ethereum, and the matching L2 gateway mints the token's Arbitrum version. A withdrawal burns the Arbitrum version, and the L1 gateway later releases tokens it holds. The events name the token by its Ethereum address, `l1Token`. Its Arbitrum address differs, and the router's `calculateL2TokenAddress(l1Token)` returns it. WETH works another way. Its deposits arrive as ETH, which the L2 WETH gateway wraps into L2 WETH, and its withdrawals send ETH to Ethereum.

## Which gateway serves a token

The router keeps a map from Ethereum token address to L2 gateway, `l1TokenToGateway` in `GatewayRouter.sol`. `getGateway(l1Token)` returns the gateway in that map, or `defaultGateway` when the map has none. It returns the zero address when the entry is `address(1)` (disabled) or not a contract. Four cases follow from that:

- Most tokens have no entry and use the default gateway, the L2 ERC20 gateway `0x09e9222E96E7B4AE2a407B98d48e330053351EEe`. On a token's first deposit it deploys a `StandardArbERC20` at an address derived from the Ethereum address (`L2ERC20Gateway.calculateL2TokenAddress`, salt `keccak256(abi.encode(l1ERC20))`). Each deposit carries the token's name, symbol and decimals for that deploy (`L1ERC20Gateway.getOutboundCalldata`). UNI and AVRK, the tokens in the examples below, use this gateway.
- A token that wants its own Arbitrum contract registers it with the L1 Arb-Custom gateway (`L1CustomGateway.registerTokenToL2`, callable by the token itself, or `forceRegisterTokenToL2` by the gateway owner) and maps itself to that gateway in the router. The L2 Arb-Custom gateway `0x096760F208390250649E3e8763348E783AEF5562` then mints and burns that contract (`L2CustomGateway.registerTokenFromL1`, event `TokenSet`).
- L1 WETH maps to the L2 WETH gateway `0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B`, which handles no other token (`L2WethGateway.calculateL2TokenAddress`).
- Some tokens have a gateway of their own, a contract pair built for that token. The token registers its L1 gateway with the L1 router (`L1GatewayRouter.setGateway`, which registers its caller and requires the caller to report `isArbitrumEnabled() == 0xb1`), or the router owner does (`setGateways`).

The L1 router stores each change, replaces each L1 gateway with its L2 counterpart in the message, and sends the message to Arbitrum. There the L2 router's `setGateway` stores it and emits `GatewaySet(l1Token, gateway)` (`L1GatewayRouter._setGateways`, `L2GatewayRouter.setGateway`). Once a token sits on a gateway other than the default, `setGateway` refuses to move it to another one. Only the owner's `setGateways` can.

### Finding a token's gateway

1. Call `getGateway(l1Token)` on the L2 router `0x5288c571Fd7aD117beA99bF60FE0846C4E84F933`. It answers for the block you call it at.
2. Read `TransferRouted.gateway`. The router emits it for each withdrawal sent through it (proof row 1).
3. Read the L2 router's `GatewaySet(address indexed l1Token, address indexed gateway)` logs with `topic1` set to the token. Its topic0, the keccak-256 of the signature in `IGatewayRouter.sol`, is `0x812ca95fe4492a9e2d1f2723c2c40c03a60a27b059581ae20ac4e4d73bfba354`. A token with no such log uses the default gateway. I did not prove this event on a real log.

### Gateways seen in October 2026

Every `WithdrawalInitiated` log on Arbitrum One in October 2026, queried on Portal by topic0 alone, came from one of these eight contracts. This is what October showed, not a full list of gateways.

| Gateway | Ethereum token | Withdrawals in October |
|---|---|---|
| `0x09e9222E96E7B4AE2a407B98d48e330053351EEe` L2 ERC20 gateway | many | 630 |
| `0x096760F208390250649E3e8763348E783AEF5562` L2 Arb-Custom gateway | many | 91 |
| `0x6D2457a4ad276000A615295f7A80F79E48CcD318` | LPT (Livepeer Token) `0x58b6A8A3302369DAEc383334672404Ee733aB239` | 27 |
| `0x65E1a5e8946e7E87d9774f5288f41c30a99fD302` | GRT (Graph Token) `0xc944E90C64B2c07662A292be6244BDf05Cda44a7` | 22 |
| `0x07D4692291B9E30E326fd31706f686f83f331B82` | wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | 21 |
| `0xCaD7828a19b363A2B44717AFB1786B5196974D8E` | ARB `0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1` | 13 |
| `0x13F7F24CA959359a4D710D32c715D4bce273C793` | USDS `0xdC035D45d973E3EC169d2276DDab16f1e407384F` | 3 |
| `0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B` L2 WETH gateway | WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 2 |

Each of the six single-token contracts emitted only its token as `l1Token`. On 2026-11-05 the router's `getGateway` returned each listed gateway for its token, and `name()` and `symbol()` on Ethereum returned the names above. The router also maps DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F` to its own gateway `0x467194771dAe2967Aef3ECbEDD3Bf9a310C76C65`, which sent no withdrawal in October.

## The two events a source needs

Every L2 gateway emits both. `L2ArbitrumGateway` declares them, and the ERC20, Arb-Custom and WETH gateways inherit it. The five gateways above that belong to one token (LPT, GRT, wstETH, ARB and USDS) emitted `WithdrawalInitiated` with the same topic0 and the same layout. I did not read their code.

### `WithdrawalInitiated(l1Token, _from, _to, _l2ToL1Id, _exitNum, _amount)`: a withdrawal to Ethereum started

| Field | Where | Meaning |
|---|---|---|
| `l1Token` | data word 0, not indexed | The token's Ethereum address, not its Arbitrum address. |
| `_from` | topic1 | The Arbitrum address whose tokens the gateway burned: the L2 user. The gateway sets it to `msg.sender`, or to the caller the router passed on when the call came through the router. |
| `_to` | topic2 | The Ethereum address that will receive the tokens: the L1 counterpart. |
| `_l2ToL1Id` | topic3 | The withdrawal's id. It equals `position` in the ArbSys `L2ToL1Tx` log of the same transaction (proof row 2), and `transactionIndex` in the Outbox's `OutBoxTransactionExecuted` log when Ethereum releases it (the pairing example below). |
| `_exitNum` | data word 1 | The gateway's running count of exits. It is also encoded in the message to Ethereum. |
| `_amount` | data word 2 | Tokens burned, in the token's base units. The L1 gateway releases this amount. |

`tx.from` is whoever signed the Arbitrum transaction. It is the L2 user when the user calls the router or gateway directly (proof row 1), but a contract or a relayer can sit in between. Use `_from`, not `tx.from`.

### `DepositFinalized(l1Token, _from, _to, _amount)`: a deposit from Ethereum finished

| Field | Where | Meaning |
|---|---|---|
| `l1Token` | topic1 | The token's Ethereum address. |
| `_from` | topic2 | The Ethereum address that sent the deposit: the L1 counterpart. The L1 gateway takes it from the L1 router, which passes on its own `msg.sender`. It is not aliased. |
| `_to` | topic3 | The Arbitrum address that received the minted tokens: the L2 user. |
| `_amount` | data word 0 | Tokens minted, in base units. |

`tx.from` of a deposit transaction is not a user. A gateway built on `L2ArbitrumGateway` accepts `finalizeInboundTransfer` only from its L1 gateway's aliased address (`onlyCounterpartGateway` in `L2ArbitrumGateway.sol`), which is the L1 gateway's address plus `0x1111000000000000000000000000000000001111` (the alias rule in `AddressAliasHelper.sol`). In proof row 4, `tx.from` is `0xb4B8B6F88361F48403514059f1f16c8E78d61FFD`, the L1 ERC20 gateway's aliased address, and `tx.to` is the L2 ERC20 gateway.

## Filtering on a token

The source in `ingestion/` reads both events from any contract, so tokens on any gateway load without a list of gateways in the source. It asks Portal for `DepositFinalized` with `topic1` set to each configured token's Ethereum address, padded to 32 bytes. It asks for every `WithdrawalInitiated`, since `l1Token` is not indexed and a query cannot filter on it. In October 2026 that was 809 logs. Raw rows keep the emitting contract.

- Any contract can emit an event with the same signature, and with any `l1Token` it likes. A raw row is not proof of a bridge move. Keep only rows whose emitter is the token's gateway, found through the router as described above. The dbt layer does this: `int_arbitrum_token_bridge_transfers` keeps rows from the gateways in `transformation/seeds/arbitrum_token_gateways.csv`, and a warning test flags rows from any other emitter.
- Keep `WithdrawalInitiated` rows whose decoded `l1Token` is the token.
- Do not use `TransferRouted` alone. A user can call the gateway directly, and then the router emits nothing.
- Drop `WithdrawalInitiated` rows whose `_from` is the gateway itself. A gateway emits one when a deposit names a token it cannot mint, to send the tokens back to the L1 sender (`triggerWithdrawal(_token, address(this), _from, ...)` in `L2ArbitrumGateway.finalizeInboundTransfer` and in each gateway's `handleNoContract`). No user started those. None of the 809 October logs was one.

## Delay before a withdrawal reaches Ethereum

The Arbitrum withdrawal guide says "Withdrawals require 6.4 days to finalize due to the challenge period". After that someone must call `Outbox.executeTransaction` on Ethereum. Nothing runs it on its own, and anyone may send it. So a withdrawal arrives no sooner than about 6.4 days after `WithdrawalInitiated`, and possibly much later.

The withdrawal in the pairing example took 6 days 13 hours 1 minute from the Arbitrum burn (block 508746303, 2026-09-25 11:19:50 UTC) to the release on Ethereum (block 26101017, 2026-10-02 00:20:59 UTC).

## Pairing an Arbitrum withdrawal with a Base deposit

On Base the matching event is `ERC20BridgeFinalized` from the L2StandardBridge (see `../op-standard-bridge/NOTES.md`). Its `remoteToken` (topic2) is the token's Ethereum address, and its `from` (topic3) is the Ethereum address that sent the deposit.

Pair an Arbitrum `WithdrawalInitiated` with a Base `ERC20BridgeFinalized` when all of these hold:

1. Arbitrum `l1Token` equals Base `remoteToken`: the same Ethereum token.
2. Arbitrum `_to` equals Base `from`: the same Ethereum address.
3. Arbitrum `_amount` equals Base `amount`. The example pair below matches to the last base unit. A token that takes a fee on transfer breaks this rule.
4. The Base deposit comes at least 6.4 days after the Arbitrum withdrawal. An earlier deposit cannot have been paid for by that withdrawal.
5. Each withdrawal and each deposit is used once. When several withdrawals fit one deposit, the data cannot say which one paid for it. Pick one rule, for example the latest withdrawal that is old enough, and report how many deposits had more than one candidate.

### The paired transfer on Ethereum

This pair moves Avarik Saga (AVRK), Ethereum address `0x607f451f850CB612a07b37b6315be23F55165610`, which the router assigns to the L2 ERC20 gateway. Its Arbitrum token is `0xA71E2738704e367798bAa2755aF5A10499634953`, and its Base token is `0xcaacD56d3d9b41D9D1272457e77F8ae510fdB688`. Ethereum shows the tokens passing through the same address:

| Step | Chain, block, time (UTC) | Transaction | What happened |
|---|---|---|---|
| Withdrawal starts | Arbitrum 508746303, 2026-09-25 11:19:50 | `0x572d717834fab8aed0d1ebf58a94242fc194817afeb3a2be314fd4269fcaf758` | `0x8100...cfab9` calls the router's `outboundTransfer`. The L2 ERC20 gateway burns 716990784284181798845975 AVRK and emits `WithdrawalInitiated` with `_to` = `0x8100...cfab9`, `_l2ToL1Id` 166275 and `_exitNum` 45858. |
| Withdrawal released | Ethereum 26101017, 2026-10-02 00:20:59 | `0x826865ede7651635961c0eeaeb5d491ba4edabc66a32687669a7bac04a382895` | `0x8100...cfab9` calls the Outbox `executeTransaction`. The Outbox's `OutBoxTransactionExecuted` names the L1 ERC20 gateway, the L2 ERC20 gateway as sender and `transactionIndex` 166275. AVRK log 4896 moves 716990784284181798845975 from the L1 ERC20 gateway to `0x8100...cfab9`, and the gateway's `WithdrawalFinalized` carries exit number 45858. |
| Deposit to Base starts | Ethereum 26101123, 2026-10-02 00:42:11 | `0xbc12ae9447d864e52685da00b86a63381a0e13839bfd88b04ff0d23074906fc8` | `0x8100...cfab9` calls the L1StandardBridge `depositERC20To` with the Base token `0xcaacD56d...`. AVRK log 215 moves 716990784284181798845975 from `0x8100...cfab9` into the bridge. |
| Deposit finishes | Base 52056280, 2026-10-02 00:45:07 | `0x46c82f0767ece316d3a1819eb8b048118bdc624021a9371347c43e0494cc62c2` | `ERC20BridgeFinalized`, `from` = `to` = `0x8100...cfab9`, 716990784284181798845975 AVRK minted. The `relayMessage` input carries the nonce and message of the Ethereum deposit's `SentMessage` log. |

`0x8100...cfab9` is `0x81004f46e7fda526bd49529b544011dad06cfab9`. The Ethereum rows came from Portal's `ethereum-mainnet` dataset. A query for AVRK `Transfer` logs with `0x8100...cfab9` as sender or receiver over blocks 26088900 to 26101400 returned these two logs and no others. I then read each of the four transactions in full.

### What the pairing cannot prove

- That the tokens deposited are the tokens withdrawn. The Ethereum address can hold more of the token, and tokens are fungible. Only the Ethereum leg, as in the table above, shows the release and the deposit in order, and even that does not tell one token unit from another.
- That the withdrawal was released before the deposit. The release is a separate Ethereum call that can come days or weeks late. Without Ethereum data, a deposit 7 days later may have used other tokens.
- Moves that change the amount or the address. A withdrawal split into two deposits, a deposit that adds tokens from elsewhere, or tokens that pass through an exchange or a second wallet on Ethereum will not match.
- Who the person is. The match links two L2 addresses through one Ethereum address. Arbitrum `_from` and Base `to` can differ, and the Ethereum address can be a contract, such as a multisig, that acts for someone else.
- Chance matches. Two unrelated transfers can share an address and amount. Round amounts make that more likely.
- Moves outside the canonical bridges. Third-party bridges and exchanges move tokens between chains without these events.

The reverse direction works the same way. Match a Base `ERC20BridgeInitiated` `to` (data word 0) against an Arbitrum `DepositFinalized` `_from` (topic2), with Base's own delay (see the Base notes).

## Proof table

Each row is one log fetched from SQD Portal for `arbitrum-one` through the Portal stream API, with a filter on the gateway and the event's topic0 and the `transaction` and `transactionLogs` options, so the rest of each transaction's logs and its input came back too. Decoding used the ABI files in `abis/`. `l2-gateway.json` equals the two events in the `L2ArbitrumGateway`, `L2ERC20Gateway`, `L2CustomGateway` and `L2WethGateway` build artifacts of `@arbitrum/token-bridge-contracts@1.2.5`. `l2-gateway-router.json` comes from `L2GatewayRouter.json` in the same package, and `arbsys.json` from `ArbSys.json` in `@arbitrum/nitro-contracts@1.1.1`. Each `topic0` in `protocol.yaml` is the keccak-256 of its signature, equals the topic0 of the same event in the ABI files, and matches the log's topic0.

The token is UNI: `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` on Ethereum and `0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0` on Arbitrum, 18 decimals. The router's `getGateway` and `calculateL2TokenAddress` return the L2 ERC20 gateway and that Arbitrum address for it. Amounts are UNI base units.

| # | Event | Block | Transaction | Log | Decoded fields | How the decoding was confirmed |
|---|---|---|---|---|---|---|
| 1 | TransferRouted | 512419364 | `0x08fbbc2faf818416b088e763589a83d9bb97101d27c3fa7b29cce78934306547` | 102 | token `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984`, _userFrom = _userTo = `0x65A8F07Bd9A8598E1b5B6C0a88F4779DBC077675`, gateway `0x09e9222E96E7B4AE2a407B98d48e330053351EEe` | `tx.from` is `0x65A8...` and `tx.to` is the router. The input decodes as router `outboundTransfer(0x1f9840a8..., 0x65A8..., 940072965341185501539, 0x)`. The withdrawal guide passes the parent-chain token address to that call. The gateway is the "L2 ERC20 Gateway" on the addresses page. |
| 2 | L2ToL1Tx | 512419364 | same | 104 | caller `0x09e9222E...` (L2 ERC20 gateway), destination `0xa3A7B6F88361F48403514059F1F16C8E78d60EeC`, position 166708, arbBlockNum 512419364, ethBlockNum 26137266, callvalue 0. `data` is `finalizeInboundTransfer(0x1f9840a8..., 0x65A8..., 0x65A8..., 940072965341185501539, data)` with exit number 46147 inside. | `data` decodes as the L1 gateway's `finalizeInboundTransfer`. The destination is the "L1 ERC20 Gateway" on the addresses page. |
| 3 | WithdrawalInitiated | 512419364 | same | 106 | l1Token `0x1f9840a8...`, _from `0x65A8...`, _to `0x65A8...`, _l2ToL1Id 166708, _exitNum 46147, _amount 940072965341185501539 | UNI Transfer log 103 burns 940072965341185501539 from `0x65A8...` to the zero address on `0xFa7F8980...`. `_l2ToL1Id` equals `position` in row 2, and `_exitNum` equals the exit number in row 2's `data`. Log 105 is the gateway's `TxToL1` (declared in `L2ArbitrumMessenger.sol`) with the same id. |
| 4 | DepositFinalized | 511075363 | `0x02a1e9ec863775ec35e47d5dfc52473c7a285245234e0eee93d1a319f86b6f3c` | 3 | l1Token `0x1f9840a8...`, _from `0x65A8...`, _to `0x65A8...`, _amount 230535619012808833421 | UNI Transfer log 2 mints 230535619012808833421 from the zero address to `0x65A8...` on `0xFa7F8980...`. The transaction has no other logs. `tx.from` is the L1 ERC20 gateway's aliased address, `tx.to` is the L2 ERC20 gateway, and the input decodes as `finalizeInboundTransfer` with the same token, addresses and amount, plus the deploy data "Uniswap", "UNI", 18. |

## Time window used for checks

October 2026 on Arbitrum One is blocks 510496864 to 520129273. Portal resolves 2026-10-01 00:00:00 UTC to block 510496864. The proof rows and the October gateway counts fall inside it. The pairing example starts before it, on 2026-09-25.
