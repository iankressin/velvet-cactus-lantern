-- Wallet addresses are lowercased, matching the Uniswap staging models.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'wallet') as wallet,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('ethereum', 'eth_balances') }}
