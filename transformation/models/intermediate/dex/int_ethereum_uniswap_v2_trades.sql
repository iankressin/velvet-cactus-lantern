-- Uniswap v2 trades in the shape dex_trades reads: each Swap of a pair the source loaded, in which the
-- swapper received one of the pair's tokens and paid the other. Amounts are in base units.
-- Rules, from catalog/protocols/uniswap/NOTES.md:
--   token0 and token1 come from the pair's PairCreated, and tx_from from the Swap's transaction.
--   amountXIn and amountXOut are what the pair received and sent, so the swapper's change in token X
--   is amountXOut - amountXIn. A flash swap can have both Ins non-zero, so the rule compares the two.
--   A Swap whose two changes are not of opposite signs traded nothing, and is left out.
with pairs as (
    select pair, token0, token1
    from {{ ref('stg_ethereum__uniswap_v2') }}
    where event = 'PairCreated'
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
        swaps.to_address,
        pairs.token0,
        pairs.token1,
        swaps.amount0_out - swaps.amount0_in as change0,
        swaps.amount1_out - swaps.amount1_in as change1
    from {{ ref('stg_ethereum__uniswap_v2') }} as swaps
    inner join pairs on pairs.pair = swaps.contract
    left join {{ ref('stg_ethereum__uniswap_v2_transactions') }} as transactions
        on transactions.hash = swaps.tx_hash
    where swaps.event = 'Swap'
)

select
    id,
    'ethereum' as chain,
    'uniswap' as protocol,
    'v2' as version,
    contract as pool,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    tx_from,
    sender,
    to_address as recipient,
    null as hooks,
    case when change0 > 0 then token0 else token1 end as token_bought,
    greatest(change0, change1) as amount_bought,
    case when change0 < 0 then token0 else token1 end as token_sold,
    -least(change0, change1) as amount_sold
from swaps
where sign(change0) * sign(change1) = -1
