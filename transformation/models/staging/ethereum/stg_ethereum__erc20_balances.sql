-- balance is null when the call reverted, e.g. the token was not deployed yet at that block.
-- Wallet and token addresses are lowercased, matching the Uniswap staging models.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'wallet') as wallet,
    lower(data ->> 'token') as token,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('ethereum', 'erc20_balances') }}
