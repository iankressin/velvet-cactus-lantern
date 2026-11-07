select round(sum(balance_tokens), 9) as sol
from {{ ref('latest_balances') }}
where blockchain = 'solana' and asset_type = 'native'
