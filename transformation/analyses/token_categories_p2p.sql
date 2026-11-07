-- Every pair of EOAs that sent the token from one to the other, most moved first: on one chain, and across
-- chains when bridge_pairs pairs a withdrawal with a deposit and both L2 ends are EOAs. chain names the
-- route of a cross-chain pair, such as arbitrum>base.
-- EIP-7702 delegated EOAs count as EOAs.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
),

same_chain as (
    select chain, from_address, to_address, sum(value) as value, count(*) as transfers
    from classified
    where category = 'p2p'
    group by chain, from_address, to_address
),

cross_chain as (
    select
        p.from_chain || '>' || p.to_chain as chain,
        p.from_address,
        p.to_address,
        sum(p.amount) as value,
        count(*) as transfers
    from {{ ref('bridge_pairs') }} as p
    join ({{ token_bridge_transfers() }}) as w on w.chain = p.from_chain and w.id = p.withdrawal_id
    join {{ ref('address_labels') }} as f on f.chain = p.from_chain and f.address = p.from_address and f.kind = 'eoa'
    join {{ ref('address_labels') }} as t on t.chain = p.to_chain and t.address = p.to_address and t.kind = 'eoa'
    group by 1, 2, 3
)

select chain, from_address, to_address, round(value / {{ token_unit() }}, 6) as amount, transfers
from (
    select * from same_chain
    union all
    select * from cross_chain
) as edges
order by value desc, chain, from_address, to_address
