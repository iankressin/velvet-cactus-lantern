-- One candle of one token against one quote asset at one interval, from one exchange: Binance or
-- Coinbase. Prices are in quote-asset units: a UNI row with quote USDT gives UNI's price in USDT.
-- volume is in token units, quote_volume in quote-asset units.
{%- set columns -%}
    exchange, token, quote, interval, open_time, close_time, open, high, low, close, volume, quote_volume, trades
{%- endset %}

select {{ columns }} from {{ ref('int_binance_token_prices') }}
union all
select {{ columns }} from {{ ref('int_coinbase_token_prices') }}
