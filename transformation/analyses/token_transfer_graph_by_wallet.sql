-- The nodes of the token's transfer graph: each address with how many addresses it sent the token to and
-- got it from, and the amount on those edges, most moved first. The same transfers as
-- token_transfer_graph_by_edge.
with transfers as (
    select from_address, to_address, value
    from ({{ token_transfers() }}) as t
    where from_address <> to_address
        and '0x0000000000000000000000000000000000000000' not in (from_address, to_address)
),

sides as (
    select from_address as address, to_address as other, 'out' as direction, value from transfers
    union all
    select to_address as address, from_address as other, 'in' as direction, value from transfers
)

select
    address,
    count(distinct other) filter (where direction = 'out') as sent_to,
    count(distinct other) filter (where direction = 'in') as received_from,
    round(coalesce(sum(value) filter (where direction = 'out'), 0) / {{ token_unit() }}, 6) as amount_sent,
    round(coalesce(sum(value) filter (where direction = 'in'), 0) / {{ token_unit() }}, 6) as amount_received,
    round((coalesce(sum(value) filter (where direction = 'in'), 0) - coalesce(sum(value) filter (where direction = 'out'), 0)) / {{ token_unit() }}, 6) as net_amount
from sides
group by address
order by sum(value) desc, address
