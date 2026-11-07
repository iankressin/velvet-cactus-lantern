-- Every address that is no exchange yet got the token from one exchange and sent it to another, most moved
-- first: which exchanges it took from and paid into, and how much.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
),

taken as (
    select to_entity as wallet, to_group as wallet_group, from_entity as exchange, sum(value) as value
    from classified
    where from_group = 'exchange' and to_group <> 'exchange'
    group by 1, 2, 3
),

paid as (
    select from_entity as wallet, from_group as wallet_group, to_entity as exchange, sum(value) as value
    from classified
    where to_group = 'exchange' and from_group <> 'exchange'
    group by 1, 2, 3
),

movers as (
    select distinct t.wallet
    from taken as t
    join paid as p on p.wallet = t.wallet and p.exchange <> t.exchange
)

select
    m.wallet,
    min(t.wallet_group) as wallet_kind,
    string_agg(distinct t.exchange, ', ' order by t.exchange) as took_from,
    (select string_agg(distinct p.exchange, ', ' order by p.exchange) from paid as p where p.wallet = m.wallet) as paid_into,
    round(sum(t.value) / {{ token_unit() }}, 6) as amount_from_exchanges,
    round((select sum(p.value) from paid as p where p.wallet = m.wallet) / {{ token_unit() }}, 6) as amount_to_exchanges
from movers as m
join taken as t on t.wallet = m.wallet
group by m.wallet
order by sum(t.value) desc, m.wallet
