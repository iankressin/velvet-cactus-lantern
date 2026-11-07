-- Base token metadata readings in the shape the tokens mart reads.
select
    id,
    'base' as chain,
    token,
    name,
    symbol,
    decimals,
    block_number,
    _loaded_at
from {{ ref('stg_base__erc20_metadata') }}
