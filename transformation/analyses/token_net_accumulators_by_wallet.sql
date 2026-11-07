-- Each address's net amount of the token over its windows: received minus sent, per chain and in total,
-- most first. The zero address is left out: mints come from it and burns go to it.
with transfers as (
    {{ token_transfers() }}
),

flows as (
    select chain, to_address as address, value as received, 0 as sent, 1 as transfers_in, 0 as transfers_out
    from transfers

    union all

    select chain, from_address as address, 0 as received, value as sent, 0 as transfers_in, 1 as transfers_out
    from transfers
)

select
    address,
    round(sum(received - sent) / {{ token_unit() }}, 6) as net_amount,
    {%- for w in var('token').windows %}
    round(sum(received - sent) filter (where chain = '{{ w.chain }}') / {{ token_unit() }}, 6) as {{ w.chain }}_net_amount,
    {%- endfor %}
    round(sum(received) / {{ token_unit() }}, 6) as received_amount,
    round(sum(sent) / {{ token_unit() }}, 6) as sent_amount,
    sum(transfers_in) as transfers_in,
    sum(transfers_out) as transfers_out
from flows
where address <> '0x0000000000000000000000000000000000000000'
group by address
order by sum(received - sent) desc, address
