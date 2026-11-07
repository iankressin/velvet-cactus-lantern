-- Every Swap a Uniswap source loaded belongs to a pool whose creation that source loaded too. The trades
-- models join the two, so a Swap without its pool would drop out of dex_trades without a word. It
-- happens when a factory store holds pools the raw table lacks, such as one kept across a reset.
select 'v2' as version, swaps.id
from {{ ref('stg_ethereum__uniswap_v2') }} as swaps
where swaps.event = 'Swap'
    and not exists (
        select 1 from {{ ref('stg_ethereum__uniswap_v2') }} as pairs
        where pairs.event = 'PairCreated' and pairs.pair = swaps.contract
    )

union all

select 'v3' as version, swaps.id
from {{ ref('stg_ethereum__uniswap_v3') }} as swaps
where swaps.event = 'Swap'
    and not exists (
        select 1 from {{ ref('stg_ethereum__uniswap_v3') }} as pools
        where pools.event = 'PoolCreated' and pools.pool = swaps.contract
    )

union all

select 'v4' as version, swaps.id
from {{ ref('stg_ethereum__uniswap_v4') }} as swaps
where swaps.event = 'Swap'
    and not exists (
        select 1 from {{ ref('stg_ethereum__uniswap_v4') }} as pools
        where pools.event = 'Initialize' and pools.pool_id = swaps.pool_id
    )
