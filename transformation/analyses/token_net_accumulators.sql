-- The address that gained the most of the token over its windows on every chain together: received minus
-- sent, the zero address left out. token_net_accumulators_by_wallet ranks every address.
with transfers as (
    {{ token_transfers() }}
),

flows as (
    select to_address as address, value as net from transfers
    union all
    select from_address as address, -value as net from transfers
)

select address as top_accumulator
from flows
where address <> '0x0000000000000000000000000000000000000000'
group by address
order by sum(net) desc, address
limit 1
