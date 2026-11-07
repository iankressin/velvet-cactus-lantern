-- One DEX trade: a Swap log in which the swapper received one token and paid another, for every pool
-- a source loads. Amounts are in each token's base units, without decimals or prices; a token of
-- 0x0000000000000000000000000000000000000000 is native ETH. tx_from signed the transaction. sender and
-- recipient are the pool's own fields, often a router; v4 has no recipient. pool is the pool's address,
-- or its id in v4. One trade can show up in two versions' rows in the same transaction, such as a v4
-- hook that fills a swap from a v2 pair. Each version's intermediate model brings its rows in this shape.
{%- set columns -%}
    id, chain, protocol, version, pool, block_number, block_timestamp, tx_hash, log_index, tx_from,
    sender, recipient, hooks, token_bought, amount_bought, token_sold, amount_sold
{%- endset %}

select {{ columns }} from {{ ref('int_ethereum_uniswap_v2_trades') }}
union all
select {{ columns }} from {{ ref('int_ethereum_uniswap_v3_trades') }}
union all
select {{ columns }} from {{ ref('int_ethereum_uniswap_v4_trades') }}
