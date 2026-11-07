select
    wallet_address as wallet,
    block_number,
    round(balance_tokens, 9) as sol,
    balance as lamports
from {{ ref('latest_balances') }}
where blockchain = 'solana' and asset_type = 'native'
order by balance desc
