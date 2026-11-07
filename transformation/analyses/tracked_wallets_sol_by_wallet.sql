select
    wallet,
    block_number,
    round(balance / 1e9, 9) as sol,
    balance as lamports
from {{ ref('latest_balances') }}
where chain = 'solana' and asset_type = 'native'
order by balance desc
