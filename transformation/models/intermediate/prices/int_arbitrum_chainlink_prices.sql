-- Chainlink rounds on Arbitrum in the shape oracle_prices reads.
-- round_id is the id the proxy reports for the round: phaseId << 64 | the aggregator's round id.
-- price multiplies by 10^-decimals: Postgres rounds a quotient to about 16 significant digits, which
-- would cut short an 18-decimal feed's price.
select
    'arbitrum' as chain,
    'chainlink' as oracle,
    rounds.id,
    feeds.feed,
    split_part(feeds.feed, ' / ', 1) as token,
    split_part(feeds.feed, ' / ', 2) as quote,
    feeds.proxy,
    rounds.aggregator,
    feeds.phase_id::numeric * 18446744073709551616 + rounds.aggregator_round_id as round_id,
    trim_scale(rounds.answer * power(10::numeric, -feeds.decimals)) as price,
    rounds.answer,
    feeds.decimals,
    rounds.updated_at,
    rounds.block_number,
    rounds.block_timestamp,
    rounds.tx_hash,
    rounds.log_index
from {{ ref('stg_arbitrum__chainlink_price_feeds') }} as rounds
inner join {{ ref('chainlink_feeds') }} as feeds
    on feeds.chain = 'arbitrum' and feeds.aggregator = rounds.aggregator
