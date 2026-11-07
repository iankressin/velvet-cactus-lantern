-- Arbitrum ERC-20 transfers in the shape erc20_transfers reads, in the token's base units.
select
    'arbitrum' as chain,
    id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    token,
    from_address,
    to_address,
    value
from {{ ref('stg_arbitrum__erc20_transfers') }}
