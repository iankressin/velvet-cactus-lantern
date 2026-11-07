-- One WithdrawalInitiated or DepositFinalized log as the arbitrum-token-bridge source loaded it, from any
-- contract: every L2 gateway emits both, and so can any other contract. Field meanings are in
-- catalog/protocols/arbitrum-token-bridge/NOTES.md. amount is in the token's base units.
select
    id,
    data ->> 'event' as event,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    lower(data -> 'args' ->> 'l1Token') as l1_token,
    lower(data -> 'args' ->> '_from') as from_address,
    lower(data -> 'args' ->> '_to') as to_address,
    (data -> 'args' ->> '_amount')::numeric as amount,
    (data -> 'args' ->> '_l2ToL1Id')::numeric as l2_to_l1_id,
    _loaded_at
from {{ source('arbitrum', 'token_bridge') }}
