-- Arbitrum's token bridge moves in the shape bridge_transfers reads, per
-- catalog/protocols/arbitrum-token-bridge/NOTES.md. A WithdrawalInitiated sends the token from the L2
-- user `_from` to the Ethereum address `_to`; a DepositFinalized brings it from the Ethereum address
-- `_from` to the L2 user `_to`. The events name the Ethereum token only, so l2_token is null.
-- Only the gateways in the arbitrum_token_gateways seed count: any contract can emit these events. A
-- withdrawal from the gateway's own address is a deposit it could not mint, sent back; no user started it.
select
    id,
    'arbitrum' as chain,
    case event when 'WithdrawalInitiated' then 'to_ethereum' else 'from_ethereum' end as direction,
    case event when 'WithdrawalInitiated' then from_address else to_address end as l2_address,
    case event when 'WithdrawalInitiated' then to_address else from_address end as ethereum_address,
    l1_token as ethereum_token,
    null::text as l2_token,
    amount,
    block_number,
    block_timestamp,
    tx_hash,
    log_index
from {{ ref('stg_arbitrum__token_bridge') }}
where contract in (select address from {{ ref('arbitrum_token_gateways') }})
    and not (event = 'WithdrawalInitiated' and from_address = contract)
