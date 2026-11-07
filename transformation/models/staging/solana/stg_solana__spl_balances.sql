-- One row per wallet, mint and run: the sum of the wallet's token accounts for that mint, in base units.
select
    id,
    (data ->> 'slot')::bigint as slot,
    data ->> 'wallet' as wallet,
    data ->> 'mint' as mint,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('solana', 'spl_balances') }}
