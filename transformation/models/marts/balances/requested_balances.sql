-- One row per wallet asset the newest load of the input asks for, with its latest balance. A repeated
-- pair keeps its first line; each invalid line keeps a row of its own, since it names no pair.
-- The cells come as written in the input; the join uses the normalized keys the balance tables use.
with lines as (
    select *
    from {{ ref('stg_input__wallet_assets') }}
    where load_id = (
        select load_id
        from {{ ref('stg_input__wallet_assets') }}
        order by _loaded_at desc
        limit 1
    )
),

-- row_number() puts every null token of a wallet in one partition, so a repeated native line drops out.
numbered as (
    select
        *,
        row_number() over (partition by blockchain, wallet, token order by line) as nth
    from lines
),

requested as (
    select *
    from numbered
    where asset_type is null or nth = 1
)

select
    requested.blockchain,
    requested.wallet_address,
    -- The input leaves the cell empty for the native asset; native says so in the output.
    coalesce(nullif(requested.token_address, ''), 'native') as token_address,
    balances.balance_tokens,
    requested.asset_type,
    balances.decimals,
    balances.balance as balance_raw,
    case
        when requested.asset_type is null then 'invalid_input'
        when balances.blockchain is null then 'no_reading'
        when balances.balance_tokens is null then 'unknown_decimals'
        else 'ok'
    end as status,
    balances.block_number,
    balances.read_at,
    requested.line as input_line
from requested
left join {{ ref('latest_balances') }} as balances
    on requested.asset_type is not null
    and balances.blockchain = requested.blockchain
    and balances.wallet_address = requested.wallet
    -- A native request has a null token, which must never match a token reading.
    and balances.token_address is not distinct from requested.token
