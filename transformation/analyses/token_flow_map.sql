-- How many addresses that are no exchange took the token out of one exchange and paid it into another.
-- token_flow_map_cross_exchange lists them.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
),

taken as (
    select distinct to_entity as wallet, from_entity as exchange
    from classified
    where from_group = 'exchange' and to_group <> 'exchange'
),

paid as (
    select distinct from_entity as wallet, to_entity as exchange
    from classified
    where to_group = 'exchange' and from_group <> 'exchange'
)

select count(distinct t.wallet) as cross_exchange_wallets
from taken as t
join paid as p on p.wallet = t.wallet and p.exchange <> t.exchange
