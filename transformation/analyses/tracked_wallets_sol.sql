select round(sum(balance) / 1e9, 9) as sol
from {{ ref('latest_balances') }}
where chain = 'solana' and asset_type = 'native'
