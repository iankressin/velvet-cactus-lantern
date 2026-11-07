-- Fails when latest_balances has more than one row for the same chain, wallet and asset.
select chain, wallet, asset
from {{ ref('latest_balances') }}
group by chain, wallet, asset
having count(*) > 1
