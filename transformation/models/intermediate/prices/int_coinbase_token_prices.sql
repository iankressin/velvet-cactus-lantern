-- Coinbase candles in the shape token_prices reads. Coinbase sends no trade count and no quote
-- volume, so quote_volume and trades are null.
select
    'coinbase' as exchange,
    id,
    base_asset as token,
    quote_asset as quote,
    interval,
    open_time,
    close_time,
    open,
    high,
    low,
    close,
    volume,
    null::numeric as quote_volume,
    null::bigint as trades
from {{ ref('stg_coinbase__candles') }}
