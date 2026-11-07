-- One row per wallet per run, at the latest finalized slot the run read. Balance is in lamports.
select
    id,
    (data ->> 'slot')::bigint as slot,
    data ->> 'wallet' as wallet,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('solana', 'sol_balances') }}
