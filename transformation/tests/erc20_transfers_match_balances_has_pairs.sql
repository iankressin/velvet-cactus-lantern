-- Warns when var('coverage') says what ethereum.erc20_transfers has loaded, yet no two balance readings
-- fall inside those blocks, so erc20_transfers_match_balances compared nothing. On a fresh setup this is
-- the usual case: balances are read at the tip, and transfers stop at the finalized head.
-- The ref below makes dbt test --select +<analysis> run this test wherever it runs the reconciliation.
-- depends_on: {{ ref('erc20_transfers') }}
{{ config(severity='warn') }}
{%- set pairs = erc20_balance_pairs() %}
{%- if var('coverage', {}).get('ethereum.erc20_transfers') %}
select count(*) as pairs from ({{ pairs }}) as pairs having count(*) = 0
{%- else %}
select 0 as pairs where false
{%- endif %}
