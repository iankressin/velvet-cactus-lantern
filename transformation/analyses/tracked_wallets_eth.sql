select round(sum(balance) / 1e18, 6) as eth
from {{ ref('latest_balances') }}
where chain = 'ethereum' and asset_type = 'native'
