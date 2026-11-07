-- The edges of the token's transfer graph: one row per sender and recipient, with the transfers and amount
-- per chain and in total, most first. Transfers to self, mints and burns are left out.
with transfers as (
    select chain, from_address, to_address, value
    from ({{ token_transfers() }}) as t
    where from_address <> to_address
        and '0x0000000000000000000000000000000000000000' not in (from_address, to_address)
)

select
    from_address,
    to_address,
    round(sum(value) / {{ token_unit() }}, 6) as amount,
    count(*) as transfers,
    {%- for w in var('token').windows %}
    round(coalesce(sum(value) filter (where chain = '{{ w.chain }}'), 0) / {{ token_unit() }}, 6) as {{ w.chain }}_amount,
    count(*) filter (where chain = '{{ w.chain }}') as {{ w.chain }}_transfers{{ "," if not loop.last }}
    {%- endfor %}
from transfers
group by from_address, to_address
order by sum(value) desc, from_address, to_address
