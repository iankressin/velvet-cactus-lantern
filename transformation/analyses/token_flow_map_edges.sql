-- The edges of the token's entity graph, most moved first: from one entity to another, per chain and
-- category, with each end's group. An exchange's addresses and deposit addresses are one entity, a mint
-- or burn's other end is bridge:<chain>, and a pair from bridge_pairs is an edge such as arbitrum>base.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
),

same_chain as (
    select
        from_entity as source,
        from_group as source_group,
        to_entity as target,
        to_group as target_group,
        chain,
        category,
        sum(value) as value,
        count(*) as transfers
    from classified
    where from_entity <> to_entity
    group by 1, 2, 3, 4, 5, 6
),

cross_chain as (
    select
        p.from_address as source,
        coalesce(f.kind, 'unknown') as source_group,
        p.to_address as target,
        coalesce(t.kind, 'unknown') as target_group,
        p.from_chain || '>' || p.to_chain as chain,
        'bridge' as category,
        sum(p.amount) as value,
        count(*) as transfers
    from {{ ref('bridge_pairs') }} as p
    join ({{ token_bridge_transfers() }}) as w on w.chain = p.from_chain and w.id = p.withdrawal_id
    left join {{ ref('address_labels') }} as f on f.chain = p.from_chain and f.address = p.from_address
    left join {{ ref('address_labels') }} as t on t.chain = p.to_chain and t.address = p.to_address
    group by 1, 2, 3, 4, 5, 6
)

select source, source_group, target, target_group, chain, category, round(value / {{ token_unit() }}, 6) as amount, transfers
from (
    select * from same_chain
    union all
    select * from cross_chain
) as edges
order by value desc, source, target, chain
