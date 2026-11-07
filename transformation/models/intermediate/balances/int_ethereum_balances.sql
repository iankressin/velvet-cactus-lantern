-- ETH and ERC-20 balances in the shape latest_balances reads. Reverted ERC-20 calls have a null
-- balance and are left out.
select
    id,
    'ethereum' as chain,
    wallet,
    'native' as asset_type,
    'eth' as asset,
    block_number,
    balance,
    _loaded_at
from {{ ref('stg_ethereum__eth_balances') }}

union all

select
    id,
    'ethereum' as chain,
    wallet,
    'erc20' as asset_type,
    token as asset,
    block_number,
    balance,
    _loaded_at
from {{ ref('stg_ethereum__erc20_balances') }}
where balance is not null
