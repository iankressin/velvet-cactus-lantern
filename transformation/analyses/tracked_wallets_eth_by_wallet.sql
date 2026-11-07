select
    wallet,
    block_number,
    round(balance / 1e18, 6) as eth,
    balance as wei
from {{ ref('latest_balances') }}
where chain = 'ethereum' and asset_type = 'native'
order by balance desc
