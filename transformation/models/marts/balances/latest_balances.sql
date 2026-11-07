-- Each wallet's latest balance of each asset, on every chain: in the asset's base units and in whole tokens.
-- Each chain's intermediate model brings its rows in this shape, so a new chain adds one branch.
-- When two readings share a block, the most recently loaded one wins.
-- token_address is null for the chain's native asset. balance_tokens is null when the decimals are unknown.
with balances as (
    select chain, wallet, asset_type, asset, decimals, block_number, balance, _loaded_at
    from {{ ref('int_ethereum_balances') }}

    union all

    select chain, wallet, asset_type, asset, decimals, block_number, balance, _loaded_at
    from {{ ref('int_solana_balances') }}

    union all

    select chain, wallet, asset_type, asset, decimals, block_number, balance, _loaded_at
    from {{ ref('int_bitcoin_balances') }}
),

-- Pick the reading before joining, so tokens can never change which reading wins.
latest as (
    select distinct on (chain, wallet, asset)
        chain,
        wallet,
        asset_type,
        asset,
        decimals,
        block_number,
        balance,
        _loaded_at
    from balances
    order by chain, wallet, asset, block_number desc, _loaded_at desc
),

-- Native rows bring their decimals; ERC-20 and SPL rows take theirs from tokens.
scaled as (
    select
        latest.*,
        coalesce(latest.decimals, tokens.decimals) as asset_decimals
    from latest
    left join {{ ref('tokens') }} as tokens
        on latest.asset_type <> 'native'
        and tokens.chain = latest.chain
        and tokens.token = latest.asset
)

select
    chain as blockchain,
    wallet as wallet_address,
    case when asset_type = 'native' then null else asset end as token_address,
    -- Multiply by a negative power of ten: it is exact, where dividing rounds after 16 significant digits.
    trim_scale(balance * power(10::numeric, -asset_decimals)) as balance_tokens,
    asset_type,
    asset_decimals as decimals,
    balance,
    block_number,
    _loaded_at as read_at
from scaled
