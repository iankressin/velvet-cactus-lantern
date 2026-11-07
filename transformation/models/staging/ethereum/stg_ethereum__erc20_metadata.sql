-- One token in the ethereum erc20 rows of input/wallet-assets.csv or evm-erc20-metadata's
-- chains/ethereum/addresses.json, read at one block; null where a call reverted.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'token') as token,
    data ->> 'name' as name,
    data ->> 'symbol' as symbol,
    (data ->> 'decimals')::integer as decimals,
    _loaded_at
from {{ source('ethereum', 'erc20_metadata') }}
