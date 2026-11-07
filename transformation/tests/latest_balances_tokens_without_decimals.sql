-- Warns with one row per token whose balance_tokens is null because tokens has no decimals for it, and stores
-- the list in analytics_dbt_test__audit.latest_balances_tokens_without_decimals.
{{ config(severity='warn', store_failures=true) }}

select blockchain, token_address, count(*) as wallets
from {{ ref('latest_balances') }}
where balance_tokens is null
group by blockchain, token_address
