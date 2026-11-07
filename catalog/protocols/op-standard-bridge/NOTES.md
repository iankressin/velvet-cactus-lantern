# OP Stack standard bridge on Base: notes

These notes cover the Base side of the OP Stack standard bridge, for any ERC-20 token. Every address, topic and block below comes from SQD Portal data, from the OP specs and Base docs pages in `protocol.yaml`, from read calls to the Base public RPC, or from the contract sources in the npm package `@eth-optimism/contracts-bedrock@0.17.3`. The proof table at the end ties each event to one real log.

A token that started on Ethereum crosses this bridge by lock, mint and burn. Its Base version is an OptimismMintableERC20 whose `remoteToken()` is the Ethereum token. A deposit locks the token in the L1StandardBridge on Ethereum, and the L2StandardBridge mints the Base version. A withdrawal burns the Base version, and the L1StandardBridge later releases tokens it holds. For a Base token that is not an OptimismMintableERC20, the L2StandardBridge holds the tokens on a withdrawal and pays them out on a deposit instead (`_initiateBridgeERC20` and `finalizeBridgeERC20` in `StandardBridge.sol`).

## The two events a source needs

Both come from the L2StandardBridge predeploy `0x4200000000000000000000000000000000000010`.

### `ERC20BridgeInitiated(localToken, remoteToken, from, to, amount, extraData)`: a withdrawal to Ethereum started

| Field | Where | Meaning |
|---|---|---|
| `localToken` | topic1 | The Base token burned. |
| `remoteToken` | topic2 | The Ethereum token to be released. |
| `from` | topic3 | The Base address whose tokens were burned: the L2 user. It is `msg.sender` of the bridge call (`bridgeERC20`, `bridgeERC20To`, `withdraw` or `withdrawTo`). |
| `to` | data word 0, not indexed | The Ethereum address that will receive the tokens: the L1 counterpart. |
| `amount` | data word 1 | Tokens burned, in the token's base units. |
| `extraData` | data | Bytes the caller attached. The bridge passes them on and does nothing with them. |

`from` is not always `tx.from`. When a contract calls the bridge, `from` is that contract. In the withdrawal `0x4511bb368ded05e23fb2fa3ec3fbd4d79f0092c93bb17ba55f905a6cfce4f3c8` (Base block 52307679), `tx.from` is `0xc94929d14435d80dd04b3206bfea9f5debabd57a`, `from` is `0x2Fb9ef510f1c52fdfDf84dfa8EEa72E431B7651D` and `to` is a third address, `0x6508eF65b0Bd57eaBD0f1D52685A70433B2d290B`.

### `ERC20BridgeFinalized(localToken, remoteToken, from, to, amount, extraData)`: a deposit from Ethereum finished

| Field | Where | Meaning |
|---|---|---|
| `localToken` | topic1 | The Base token minted. |
| `remoteToken` | topic2 | The Ethereum token locked. |
| `from` | topic3 | The Ethereum address that sent the deposit: the L1 counterpart. It is `msg.sender` of the L1StandardBridge call. It travels inside the message, so it is not aliased. `depositERC20` and `bridgeERC20` on Ethereum accept only EOAs, but `depositERC20To` and `bridgeERC20To` accept contracts, so `from` can be a contract. |
| `to` | data word 0, not indexed | The Base address that received the minted tokens: the L2 user. |
| `amount` | data word 1 | Tokens minted, in base units. |

`tx.from` of a deposit transaction is normally not a user. When the L1 messenger delivers the deposit, `tx.from` is `0x977F82a600a1414E583f7F13623F1ac5D58B1C0b`, the L1CrossDomainMessenger's address plus `0x1111000000000000000000000000000000001111` (the alias rule in `AddressAliasHelper.sol`). `tx.to` is the L2CrossDomainMessenger and the call is `relayMessage`. If that call fails, the messenger marks the message failed and anyone can replay it later. The event then lands in the replay transaction, with the replayer as `tx.from`.

### Legacy twins: do not load both

For every ERC-20 bridge, the L2StandardBridge emits a legacy event just before the new one, with the same values and the two tokens in the other order:

- `WithdrawalInitiated(l1Token, l2Token, from, to, amount, extraData)` before `ERC20BridgeInitiated` (proof rows 4 and 5).
- `DepositFinalized(l1Token, l2Token, from, to, amount, extraData)` before `ERC20BridgeFinalized` (proof rows 1 and 2).

Loading both counts every transfer twice. This entry picks the `ERC20Bridge*` pair because the contract source tags the other two events `@custom:legacy`, and the legacy `withdraw` functions say they are "Subject to be deprecated in the future". The package's L2StandardBridge is version 1.10.0. Base may run another version, but the topic0s above match Base's logs. The legacy events also fire for ETH, with `l1Token` the zero address and `l2Token` `0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000`. A token filter drops those.

## Filtering on a token

- Withdrawals: `address = l2_standard_bridge`, `topic0 = ERC20BridgeInitiated`, `topic1` = the Base token's address padded to 32 bytes. For UNI on Base that is `0x000000000000000000000000c3de830ea07524a0761646a6a4e4be0e114a3c83`.
- Deposits: the same with `topic0 = ERC20BridgeFinalized`.

The bridge mints or burns an OptimismMintableERC20 only after checking that the other token is that token's `remoteToken()` (`_isCorrectTokenPair` in `StandardBridge.sol`). So when the Base token is an OptimismMintableERC20 and `topic1` is set to it, `remoteToken` is always its Ethereum token. Never filter on `topic2` alone. The OptimismMintableERC20Factory lets anyone create another Base token with the same remote token, and a depositor on Ethereum names the Base token to mint. For a Base token that is not an OptimismMintableERC20, the bridge keeps a balance per token pair (`deposits[localToken][remoteToken]`) and takes `remoteToken` from the caller, so filter on both topics.

OptimismMintableERC20 lets only its `BRIDGE` mint and burn. If a Base token runs that code, every mint or burn of it is a bridge deposit or withdrawal. UNI on Base, `0xc3De830EA07524a0761646a6a4e4be0e114a3C83`, returned `remoteToken()` = L1 UNI and `bridge()` = the L2StandardBridge on 2026-11-05, and its `Mint` and `Burn` logs in proof rows 1 and 4 have the OptimismMintableERC20 topic0s. I did not compare its bytecode.

## Delay before a withdrawal reaches Ethereum

Base's Withdrawals page lists three steps. The withdrawal is sent on Base, which records it in the L2ToL1MessagePasser (event `MessagePassed`). Once the Base state is posted to Ethereum, "anyone can submit a proof to the `OptimismPortal` contract". After the finalization window, "anyone can finalize the withdrawal on Ethereum". The window is "5 days for a single-proof dispute game and 1 day on the dual-proof fast path", the fast path applying "when both a TEE proof and a ZK proof back the same proposal". Posting the state "usually adds only about 20 to 60 minutes". The Transaction Finality page gives the same 5 days or 1 day. The Withdrawals page says the Beryl upgrade brought these windows but gives no date, and the Base events do not say which window applied to a given withdrawal. The OP docs page gives 7 days, but for OP Mainnet.

Deposits are quick. The Transaction Finality page says deposits "typically get included within 3 minutes by the Base sequencer". The proof deposit (row 1) and the deposit in the pairing example each landed on Base 2 minutes 56 seconds after their Ethereum transaction.

## Pairing an Arbitrum withdrawal with a Base deposit

The Arbitrum event is `WithdrawalInitiated` from the token's L2 gateway (see `../arbitrum-token-bridge/NOTES.md`, which has the full rules and limits). Pair it with a Base `ERC20BridgeFinalized` when:

1. Arbitrum `l1Token` (data word 0) equals Base `remoteToken` (topic2): the same Ethereum token.
2. Arbitrum `_to` (topic2) equals Base `from` (topic3): the same Ethereum address.
3. Arbitrum `_amount` equals Base `amount`.
4. The Base deposit comes at least 6.4 days after the Arbitrum withdrawal, the challenge period the Arbitrum docs give.
5. Each withdrawal and each deposit is used once.

This pair moves Avarik Saga (AVRK), Ethereum address `0x607f451f850CB612a07b37b6315be23F55165610`. Its Base token `0xcaacD56d3d9b41D9D1272457e77F8ae510fdB688` returned `remoteToken()` = that address on 2026-11-05. Ethereum shows the tokens passing through the same address in between:

| Step | Chain, block, time (UTC) | Transaction | What happened |
|---|---|---|---|
| Withdrawal starts | Arbitrum 508746303, 2026-09-25 11:19:50 | `0x572d717834fab8aed0d1ebf58a94242fc194817afeb3a2be314fd4269fcaf758` | The L2 ERC20 gateway burns 716990784284181798845975 AVRK from `0x8100...cfab9`, `_to` = `0x8100...cfab9` |
| Withdrawal released | Ethereum 26101017, 2026-10-02 00:20:59 | `0x826865ede7651635961c0eeaeb5d491ba4edabc66a32687669a7bac04a382895` | `0x8100...cfab9` calls the Arbitrum Outbox. AVRK log 4896 moves 716990784284181798845975 from the Arbitrum L1 ERC20 gateway to `0x8100...cfab9` |
| Deposit to Base starts | Ethereum 26101123, 2026-10-02 00:42:11 | `0xbc12ae9447d864e52685da00b86a63381a0e13839bfd88b04ff0d23074906fc8` | `0x8100...cfab9` calls `depositERC20To` on the L1StandardBridge. AVRK log 215 moves 716990784284181798845975 into the bridge |
| Deposit finishes | Base 52056280, 2026-10-02 00:45:07 | `0x46c82f0767ece316d3a1819eb8b048118bdc624021a9371347c43e0494cc62c2` | `ERC20BridgeFinalized`, `localToken` `0xcaacD56d...`, `from` = `to` = `0x8100...cfab9`, 716990784284181798845975 minted |

`0x8100...cfab9` is `0x81004f46e7fda526bd49529b544011dad06cfab9`.

The match cannot prove that the tokens deposited are the tokens withdrawn, since the Ethereum address can hold more of the token. It cannot show that the withdrawal was released before the deposit without Ethereum data, and it misses moves that split amounts, change addresses, or use exchanges and third-party bridges. It links two L2 addresses through one Ethereum address, which can be a contract acting for someone else. Equal amounts can also match by chance.

## Proof table

Each row is one log fetched from SQD Portal for `base-mainnet` through the Portal stream API with the `transaction` and `transactionLogs` options, so the rest of each transaction's logs and its input came back too. Rows 1 to 3 came from a filter on the L2StandardBridge and `ERC20BridgeFinalized` in block 52025254. Rows 4 to 6 came from a filter on the L2StandardBridge and `ERC20BridgeInitiated` in block 52027687. Decoding used the ABI files in `abis/`, taken from `L2StandardBridge.json`, `L2CrossDomainMessenger.json` and `L2ToL1MessagePasser.json` in `@eth-optimism/contracts-bedrock@0.17.3`. Each `topic0` in `protocol.yaml` is the keccak-256 of its signature, equals the topic0 of the same event in the ABI files, and matches the log's topic0.

The token is UNI: `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` on Ethereum and `0xc3De830EA07524a0761646a6a4e4be0e114a3C83` on Base, 18 decimals. Amounts are UNI base units.

| # | Event | Block | Transaction | Log | Decoded fields | How the decoding was confirmed |
|---|---|---|---|---|---|---|
| 1 | ERC20BridgeFinalized | 52025254 | `0x8dd58d58785ea1396b87f9f5dffc578225a18882281dcb1e5456211688bdeb2d` | 3 | localToken `0xc3De830EA07524a0761646a6a4e4be0e114a3C83`, remoteToken `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984`, from `0xA04059173992cA1A468Ed4EcDcbC73De5fF1001C`, to `0xb59388D316381aB420722f6Fea48bAf3a386E056`, amount 2000000000000000000000, extraData `0x` | UNI Transfer log 0 mints 2000000000000000000000 from the zero address to `to`, and log 1 is the token's `Mint` for the same account and amount. `tx.from` is the L1CrossDomainMessenger's aliased address. The input decodes as `relayMessage` with `_sender` the L1StandardBridge `0x3154Cf16...` and `_target` the L2StandardBridge, and its message as `finalizeBridgeERC20` with the same tokens, addresses and amount. On Ethereum, block 26095973 (2026-10-01 07:27:59 UTC), `from` calls the L1StandardBridge's `bridgeERC20To` in `0xbd7eee49958904d1e822fea59d90741dddd8f571ce36430a715a73913d2e961e`. UNI log 102 moves the same amount from `from` into the bridge, and the messenger's `SentMessage` log carries the same nonce and message as the Base `relayMessage`. |
| 2 | DepositFinalized (legacy) | 52025254 | same | 2 | l1Token `0x1f9840a8...`, l2Token `0xc3De830E...`, from `0xA0405917...`, to `0xb59388D3...`, amount 2000000000000000000000 | Same values as row 1, tokens in the other order. |
| 3 | RelayedMessage | 52025254 | same | 4 | msgHash `0xda31b2dde91f2b3f212675f017e91edede93931c2cca1c31d1deaec17eed575e` | The keccak-256 of the transaction's `relayMessage` calldata equals `msgHash`, as `Hashing.hashCrossDomainMessageV1` defines it. The nonce carries version 1. |
| 4 | ERC20BridgeInitiated | 52027687 | `0x4906fbc32a6856846e4a5dca016c33c900cc973ea40ab23b5f644342dce3281a` | 215 | localToken `0xc3De830E...`, remoteToken `0x1f9840a8...`, from = to = `0x15409d50246a78f2D14fe31d752FFD843039094d`, amount 1139238296067820365009, extraData `0x` | UNI Transfer log 212 burns 1139238296067820365009 from `from` to the zero address, and log 213 is the token's `Burn`. `tx.from` is `from`, `tx.to` is the L2StandardBridge, and the input selector `0x32b7006d` is `withdraw(address,uint256,uint32,bytes)` with the Base token and the same amount. Row 6 carries the same values to Ethereum. |
| 5 | WithdrawalInitiated (legacy) | 52027687 | same | 214 | l1Token `0x1f9840a8...`, l2Token `0xc3De830E...`, from = to = `0x15409d50...`, amount 1139238296067820365009 | Same values as row 4, tokens in the other order. |
| 6 | MessagePassed | 52027687 | same | 216 | sender `0x4200000000000000000000000000000000000007`, target `0x866E82a600A1414e583f7F13623F1aC5d58b0Afa`, value 0, gasLimit 288648, withdrawalHash `0x8e12f09fe6cc412c75fa2d3364ae6f693f1280c4bebfa19acec914c6de98a8dc` | `withdrawalHash` equals keccak-256 of `abi.encode(nonce, sender, target, value, gasLimit, data)`, as `Hashing.hashWithdrawal` defines it. The target is the L1CrossDomainMessenger on the Base contracts page. `data` decodes as `relayMessage` from the L2StandardBridge to the L1StandardBridge `0x3154Cf16...`, carrying `finalizeBridgeERC20(0x1f9840a8..., 0xc3De830E..., 0x15409d50..., 0x15409d50..., 1139238296067820365009, 0x)`. Log 217 is the L2CrossDomainMessenger's `SentMessage` with the same nonce and message, and log 218 its `SentMessageExtension1`. |

## Time window used for checks

October 2026 on Base is blocks 52011727 to 53350926. The proof rows fall inside it, as does the Base deposit in the pairing example.
