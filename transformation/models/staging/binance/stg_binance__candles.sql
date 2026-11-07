-- One Binance candle per row. Prices are in quote-asset units, volume in base-asset units.
-- open_time and close_time come from epoch milliseconds; close_time is the candle's last millisecond.
select
    id,
    data ->> 'symbol' as symbol,
    data ->> 'base_asset' as base_asset,
    data ->> 'quote_asset' as quote_asset,
    data ->> 'interval' as interval,
    to_timestamp((data ->> 'open_time')::bigint / 1000.0) as open_time,
    to_timestamp((data ->> 'close_time')::bigint / 1000.0) as close_time,
    (data ->> 'open')::numeric as open,
    (data ->> 'high')::numeric as high,
    (data ->> 'low')::numeric as low,
    (data ->> 'close')::numeric as close,
    (data ->> 'volume')::numeric as volume,
    (data ->> 'quote_volume')::numeric as quote_volume,
    (data ->> 'trades')::bigint as trades,
    (data ->> 'taker_buy_base_volume')::numeric as taker_buy_base_volume,
    (data ->> 'taker_buy_quote_volume')::numeric as taker_buy_quote_volume,
    _loaded_at
from {{ source('binance', 'candles') }}
