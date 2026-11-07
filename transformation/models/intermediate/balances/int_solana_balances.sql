-- SOL and SPL token balances in the shape latest_balances reads. block_number is the slot.
select
    id,
    'solana' as chain,
    wallet,
    'native' as asset_type,
    'sol' as asset,
    slot as block_number,
    balance,
    _loaded_at
from {{ ref('stg_solana__sol_balances') }}

union all

select
    id,
    'solana' as chain,
    wallet,
    'spl' as asset_type,
    mint as asset,
    slot as block_number,
    balance,
    _loaded_at
from {{ ref('stg_solana__spl_balances') }}
