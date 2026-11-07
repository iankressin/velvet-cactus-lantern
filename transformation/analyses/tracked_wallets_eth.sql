select round(sum(balance_tokens), 6) as eth
from {{ ref('latest_balances') }}
where blockchain = 'ethereum' and asset_type = 'native'
