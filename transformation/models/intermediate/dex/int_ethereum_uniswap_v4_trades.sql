-- Uniswap v4 trades in the shape dex_trades reads: each Swap of a pool the source loaded, in which the
-- swapper received one of the pool's currencies and paid the other. Amounts are in base units, and a
-- currency of 0x0000000000000000000000000000000000000000 is native ETH.
-- Rules, from catalog/protocols/uniswap/NOTES.md:
--   v4 has no pool contracts: pool_id names the pool, and currency0, currency1 and hooks come from its
--   Initialize. tx_from comes from the Swap's transaction.
--   amount0 and amount1 are the swapper's balance changes already, the opposite sign to v3.
--   A Swap whose two changes are not of opposite signs traded nothing, and is left out, such as a
--   hook's own Swap with both amounts 0.
--   v4 has no recipient: the output goes wherever the sender later takes it.
with pools as (
    select pool_id, currency0, currency1, hooks
    from {{ ref('stg_ethereum__uniswap_v4') }}
    where event = 'Initialize'
),

swaps as (
    select
        swaps.id,
        swaps.pool_id,
        swaps.block_number,
        swaps.block_timestamp,
        swaps.tx_hash,
        swaps.log_index,
        transactions.from_address as tx_from,
        swaps.sender,
        swaps.amount0,
        swaps.amount1,
        pools.currency0,
        pools.currency1,
        pools.hooks
    from {{ ref('stg_ethereum__uniswap_v4') }} as swaps
    inner join pools on pools.pool_id = swaps.pool_id
    left join {{ ref('stg_ethereum__uniswap_v4_transactions') }} as transactions
        on transactions.hash = swaps.tx_hash
    where swaps.event = 'Swap'
)

select
    id,
    'ethereum' as chain,
    'uniswap' as protocol,
    'v4' as version,
    pool_id as pool,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    tx_from,
    sender,
    null as recipient,
    hooks,
    case when amount0 > 0 then currency0 else currency1 end as token_bought,
    greatest(amount0, amount1) as amount_bought,
    case when amount0 < 0 then currency0 else currency1 end as token_sold,
    -least(amount0, amount1) as amount_sold
from swaps
where sign(amount0) * sign(amount1) = -1
