-- The token moved from each group of entity to each other: exchange, contract, eoa, bridge. Moves between
-- an exchange's own addresses are left out.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
)

select
    from_group as source_group,
    to_group as target_group,
    round(sum(value) / {{ token_unit() }}, 6) as amount,
    count(*) as transfers,
    count(distinct from_entity) as sources,
    count(distinct to_entity) as targets
from classified
where from_entity <> to_entity
group by from_group, to_group
order by sum(value) desc
