-- Lists each feed in the chainlink_feeds seed with no round in the two heartbeats before the last block
-- its chain's source read. That block is the source's Pipes cursor in _sync, which keeps moving when no
-- feed posts, so feeds that all stop at once still show up. A feed with no round at all counts from the
-- chain's first round.
{{ config(severity='warn') }}
with cursors as (
    select id, max("current_timestamp") as read_to
    from "{{ env_var('RAW_SCHEMA', 'raw') }}"._sync
    group by id
),

feeds as (
    select chain, proxy, feed, max(heartbeat_seconds) as heartbeat_seconds
    from {{ ref('chainlink_feeds') }}
    group by chain, proxy, feed
),

latest_rounds as (
    select chain, proxy, max(updated_at) as updated_at
    from {{ ref('oracle_prices') }}
    group by chain, proxy
),

first_rounds as (
    select chain, min(updated_at) as updated_at
    from {{ ref('oracle_prices') }}
    group by chain
)

select
    feeds.chain,
    feeds.feed,
    feeds.proxy,
    latest_rounds.updated_at as latest_round,
    cursors.read_to,
    feeds.heartbeat_seconds
from feeds
inner join cursors on cursors.id = feeds.chain || '_chainlink_price_feeds'
left join latest_rounds on latest_rounds.chain = feeds.chain and latest_rounds.proxy = feeds.proxy
left join first_rounds on first_rounds.chain = feeds.chain
where coalesce(latest_rounds.updated_at, first_rounds.updated_at) is null
    or coalesce(latest_rounds.updated_at, first_rounds.updated_at)
    < cursors.read_to - 2 * feeds.heartbeat_seconds * interval '1 second'
