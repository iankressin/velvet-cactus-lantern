{#- Each two consecutive balance readings of a wallet and token in the addresses.json of
    ethereum.erc20_transfers, from the block before its START_BLOCK to its cursor: the readings its
    transfers can explain. bj answer passes what the source has loaded, as `bj coverage` prints it, in
    var('coverage'). Without it, as in a scheduled build, or before the source's first run, no rows. -#}
{%- macro erc20_balance_pairs() %}
{%- set balances = ref('stg_ethereum__erc20_balances') %}
{%- set loaded = var('coverage', {}).get('ethereum.erc20_transfers') %}
{%- if loaded and loaded.covered %}
{%- set start_block, cursor = loaded.covered %}
{%- set wallets = loaded.filter.wallets | map('lower') | map('replace', "'", "''") | join("', '") %}
{%- set tokens = loaded.filter.tokens | map('lower') | map('replace', "'", "''") | join("', '") %}
select * from (
    select
        wallet,
        token,
        lag(block_number) over (partition by wallet, token order by block_number) as from_block,
        block_number as to_block,
        balance - lag(balance) over (partition by wallet, token order by block_number) as balance_change
    from {{ balances }}
    where balance is not null
        and block_number between {{ start_block - 1 }} and {{ cursor }}
        and wallet in ('{{ wallets }}')
        and token in ('{{ tokens }}')
) as readings
where from_block is not null
{%- else %}
select null::text as wallet, null::text as token, null::bigint as from_block, null::bigint as to_block, null::numeric as balance_change
where false
{%- endif %}
{%- endmacro %}
