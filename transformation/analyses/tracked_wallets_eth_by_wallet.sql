select
    wallet_address as wallet,
    block_number,
    round(balance_tokens, 6) as eth,
    balance as wei
from {{ ref('latest_balances') }}
where blockchain = 'ethereum' and asset_type = 'native'
order by balance desc
