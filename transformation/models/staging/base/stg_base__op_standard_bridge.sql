-- One ERC20BridgeInitiated or ERC20BridgeFinalized log of Base's L2StandardBridge, as the
-- evm-op-standard-bridge source loaded it. Field meanings are in
-- catalog/protocols/op-standard-bridge/NOTES.md. amount is in the token's base units.
select
    id,
    data ->> 'event' as event,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    lower(data -> 'args' ->> 'localToken') as local_token,
    lower(data -> 'args' ->> 'remoteToken') as remote_token,
    lower(data -> 'args' ->> 'from') as from_address,
    lower(data -> 'args' ->> 'to') as to_address,
    (data -> 'args' ->> 'amount')::numeric as amount,
    _loaded_at
from {{ source('base', 'op_standard_bridge') }}
