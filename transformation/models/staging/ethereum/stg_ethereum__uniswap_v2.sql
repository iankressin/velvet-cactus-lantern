-- One Uniswap v2 log as the source loaded it: a PairCreated naming a token in its addresses.json, or a
-- Swap of such a pair. Each event fills the columns of its own arguments and leaves the others null.
-- Amounts are in the token's base units, as the pair emitted them.
select
    id,
    data ->> 'event' as event,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    -- PairCreated. Its fourth argument has no name in the ABI; the factory emits allPairs.length there.
    lower(data -> 'args' ->> 'token0') as token0,
    lower(data -> 'args' ->> 'token1') as token1,
    lower(data -> 'args' ->> 'pair') as pair,
    (data -> 'args' ->> '_3')::bigint as all_pairs_length,
    -- Swap
    lower(data -> 'args' ->> 'sender') as sender,
    (data -> 'args' ->> 'amount0In')::numeric as amount0_in,
    (data -> 'args' ->> 'amount1In')::numeric as amount1_in,
    (data -> 'args' ->> 'amount0Out')::numeric as amount0_out,
    (data -> 'args' ->> 'amount1Out')::numeric as amount1_out,
    lower(data -> 'args' ->> 'to') as to_address,
    _loaded_at
from {{ source('ethereum', 'uniswap_v2') }}
where data ->> 'kind' = 'log'
