-- One row per wallet per run, at the chain tip the run's scan read. Balance is in satoshis.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'wallet' as wallet,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('bitcoin', 'btc_balances') }}
