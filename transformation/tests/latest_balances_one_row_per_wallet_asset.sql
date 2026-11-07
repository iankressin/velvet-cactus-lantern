-- Fails when latest_balances has more than one row for the same chain, wallet and asset.
-- token_address is null for the native asset, and group by puts nulls together, so a wallet's native row counts once.
select blockchain, wallet_address, token_address
from {{ ref('latest_balances') }}
group by blockchain, wallet_address, token_address
having count(*) > 1
