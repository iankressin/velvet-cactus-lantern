-- Arbitrum token metadata readings in the shape the tokens mart reads.
select
    id,
    'arbitrum' as chain,
    token,
    name,
    symbol,
    decimals,
    block_number,
    _loaded_at
from {{ ref('stg_arbitrum__erc20_metadata') }}
