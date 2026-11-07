-- Each token's latest name, symbol and decimals, on every chain this mart covers.
-- Each chain's intermediate model brings its rows in this shape, so a new chain adds one branch.
-- When two readings share a block, the most recently loaded one wins.
with readings as (
    select chain, token, name, symbol, decimals, block_number, _loaded_at
    from {{ ref('int_ethereum_erc20_metadata') }}

    union all

    select chain, token, name, symbol, decimals, block_number, _loaded_at
    from {{ ref('int_arbitrum_erc20_metadata') }}

    union all

    select chain, token, name, symbol, decimals, block_number, _loaded_at
    from {{ ref('int_base_erc20_metadata') }}
)

select distinct on (chain, token)
    chain,
    token,
    name,
    symbol,
    decimals,
    block_number
from readings
order by chain, token, block_number desc, _loaded_at desc
