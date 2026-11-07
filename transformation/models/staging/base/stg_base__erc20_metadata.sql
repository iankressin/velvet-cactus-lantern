-- One token in chains/base/addresses.json of evm-erc20-metadata, read at one block; null where a call reverted.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'token') as token,
    data ->> 'name' as name,
    data ->> 'symbol' as symbol,
    (data ->> 'decimals')::integer as decimals,
    _loaded_at
from {{ source('base', 'erc20_metadata') }}
