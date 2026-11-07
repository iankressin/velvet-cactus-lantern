-- How many edges the token's transfer graph has: pairs of addresses where the first sent the second the
-- token. token_transfer_graph_by_edge lists them.
select count(*) as edges
from (
    select distinct from_address, to_address
    from ({{ token_transfers() }}) as t
    where from_address <> to_address
        and '0x0000000000000000000000000000000000000000' not in (from_address, to_address)
) as edges
