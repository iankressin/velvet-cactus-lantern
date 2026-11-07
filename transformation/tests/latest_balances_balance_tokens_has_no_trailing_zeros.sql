-- Fails on a balance_tokens that ends in a zero after the decimal point, such as 1.50 or 0.000.
-- The unit test can't catch these: numeric equality treats 1.5 and 1.50 as the same number.
select blockchain, wallet_address, token_address, balance_tokens
from {{ ref('latest_balances') }}
where balance_tokens::text ~ '\.[0-9]*0$'
