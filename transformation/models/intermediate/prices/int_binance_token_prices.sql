-- Binance candles in the shape token_prices reads. Binance counts the trades in a candle and sums
-- the quote asset they moved, so quote_volume and trades are set.
select
    'binance' as exchange,
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
    quote_volume,
    trades
from {{ ref('stg_binance__candles') }}
