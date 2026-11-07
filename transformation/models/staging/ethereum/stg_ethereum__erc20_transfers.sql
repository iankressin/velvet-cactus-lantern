-- One Transfer log of a token in chains/ethereum/addresses.json of evm-erc20-transfers, into or out
-- of one of its wallets. value is in the token's base units. Token, from and to addresses are lowercased.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'token') as token,
    lower(data ->> 'from') as from_address,
    lower(data ->> 'to') as to_address,
    (data ->> 'value')::numeric as value,
    _loaded_at
from {{ source('ethereum', 'erc20_transfers') }}
