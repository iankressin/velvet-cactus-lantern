-- Uniswap v3 trades in the shape dex_trades reads: each Swap of a pool the source loaded, in which the
-- swapper received one of the pool's tokens and paid the other. Amounts are in base units.
-- Rules, from catalog/protocols/uniswap/NOTES.md:
--   token0 and token1 come from the pool's PoolCreated, and tx_from from the Swap's transaction.
--   amount0 and amount1 are the pool's balance changes, so the swapper's change is their negative.
--   A Swap whose two changes are not of opposite signs traded nothing, and is left out.
with pools as (
    select pool, token0, token1
    from {{ ref('stg_ethereum__uniswap_v3') }}
    where event = 'PoolCreated'
),

swaps as (
    select
        swaps.id,
        swaps.contract,
        swaps.block_number,
        swaps.block_timestamp,
        swaps.tx_hash,
        swaps.log_index,
        transactions.from_address as tx_from,
        swaps.sender,
        swaps.recipient,
        pools.token0,
        pools.token1,
        -swaps.amount0 as change0,
        -swaps.amount1 as change1
    from {{ ref('stg_ethereum__uniswap_v3') }} as swaps
    inner join pools on pools.pool = swaps.contract
    left join {{ ref('stg_ethereum__uniswap_v3_transactions') }} as transactions
        on transactions.hash = swaps.tx_hash
    where swaps.event = 'Swap'
)

select
    id,
    'ethereum' as chain,
    'uniswap' as protocol,
    'v3' as version,
    contract as pool,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    tx_from,
    sender,
    recipient,
    null as hooks,
    case when change0 > 0 then token0 else token1 end as token_bought,
    greatest(change0, change1) as amount_bought,
    case when change0 < 0 then token0 else token1 end as token_sold,
    -least(change0, change1) as amount_sold
from swaps
where sign(change0) * sign(change1) = -1
