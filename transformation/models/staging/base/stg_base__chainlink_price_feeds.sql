-- One AnswerUpdated log as the evm-chainlink-price-feeds source loaded it, from an aggregator in its
-- addresses.json. answer is an integer in the feed's decimals.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as aggregator,
    (data -> 'args' ->> 'current')::numeric as answer,
    (data -> 'args' ->> 'roundId')::numeric as aggregator_round_id,
    to_timestamp((data -> 'args' ->> 'updatedAt')::bigint) as updated_at,
    _loaded_at
from {{ source('base', 'chainlink_price_feeds') }}
