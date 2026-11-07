-- One round of one oracle price feed, with its price in quote units: an ETH / USD row gives ETH's price
-- in USD.
{%- set columns -%}
    chain, oracle, id, feed, token, quote, proxy, aggregator, round_id, price, answer, decimals,
    updated_at, block_number, block_timestamp, tx_hash, log_index
{%- endset %}

select {{ columns }} from {{ ref('int_ethereum_chainlink_prices') }}
union all
select {{ columns }} from {{ ref('int_arbitrum_chainlink_prices') }}
union all
select {{ columns }} from {{ ref('int_base_chainlink_prices') }}
