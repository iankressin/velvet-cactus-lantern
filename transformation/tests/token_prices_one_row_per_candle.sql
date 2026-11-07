-- Fails when token_prices has more than one row for the same exchange, token, quote, interval and open time.
select exchange, token, quote, interval, open_time
from {{ ref('token_prices') }}
group by exchange, token, quote, interval, open_time
having count(*) > 1
