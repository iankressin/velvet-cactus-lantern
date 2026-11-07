-- One Uniswap v3 log as the source loaded it: a PoolCreated naming a token in its addresses.json, or a
-- Swap of such a pool. Each event fills the columns of its own arguments and leaves the others null.
-- Amounts are in the token's base units, signed as the pool emitted them.
select
    id,
    data ->> 'event' as event,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    -- PoolCreated
    lower(data -> 'args' ->> 'token0') as token0,
    lower(data -> 'args' ->> 'token1') as token1,
    (data -> 'args' ->> 'fee')::integer as fee,
    (data -> 'args' ->> 'tickSpacing')::integer as tick_spacing,
    lower(data -> 'args' ->> 'pool') as pool,
    -- Swap
    lower(data -> 'args' ->> 'sender') as sender,
    lower(data -> 'args' ->> 'recipient') as recipient,
    (data -> 'args' ->> 'amount0')::numeric as amount0,
    (data -> 'args' ->> 'amount1')::numeric as amount1,
    (data -> 'args' ->> 'sqrtPriceX96')::numeric as sqrt_price_x96,
    (data -> 'args' ->> 'liquidity')::numeric as liquidity,
    (data -> 'args' ->> 'tick')::integer as tick,
    _loaded_at
from {{ source('ethereum', 'uniswap_v3') }}
where data ->> 'kind' = 'log'
