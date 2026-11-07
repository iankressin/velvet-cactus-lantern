-- Ethereum token metadata readings in the shape the tokens mart reads.
select
    id,
    'ethereum' as chain,
    token,
    name,
    symbol,
    decimals,
    block_number,
    _loaded_at
from {{ ref('stg_ethereum__erc20_metadata') }}
