-- One Uniswap v4 log as the source loaded it: an Initialize naming a token in its addresses.json, or a
-- Swap of such a pool. The PoolManager emits both, and pool_id names the pool. Each event fills the
-- columns of its own arguments and leaves the others null. Amounts are in the token's base units,
-- signed as emitted. A currency of 0x0000000000000000000000000000000000000000 is native ETH.
select
    id,
    data ->> 'event' as event,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    -- Initialize and Swap
    lower(data -> 'args' ->> 'id') as pool_id,
    (data -> 'args' ->> 'fee')::integer as fee,
    (data -> 'args' ->> 'sqrtPriceX96')::numeric as sqrt_price_x96,
    (data -> 'args' ->> 'tick')::integer as tick,
    -- Initialize
    lower(data -> 'args' ->> 'currency0') as currency0,
    lower(data -> 'args' ->> 'currency1') as currency1,
    (data -> 'args' ->> 'tickSpacing')::integer as tick_spacing,
    lower(data -> 'args' ->> 'hooks') as hooks,
    -- Swap
    lower(data -> 'args' ->> 'sender') as sender,
    (data -> 'args' ->> 'amount0')::numeric as amount0,
    (data -> 'args' ->> 'amount1')::numeric as amount1,
    (data -> 'args' ->> 'liquidity')::numeric as liquidity,
    _loaded_at
from {{ source('ethereum', 'uniswap_v4') }}
where data ->> 'kind' = 'log'
