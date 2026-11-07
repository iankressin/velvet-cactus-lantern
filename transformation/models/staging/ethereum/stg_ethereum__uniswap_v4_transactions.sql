-- One transaction that a log of the Uniswap v4 source came from, as Portal returned it. The logs are in
-- stg_ethereum__uniswap_v4, and their tx_hash is this hash.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'hash' as hash,
    lower(data ->> 'from') as from_address,
    _loaded_at
from {{ source('ethereum', 'uniswap_v4') }}
where data ->> 'kind' = 'transaction'
