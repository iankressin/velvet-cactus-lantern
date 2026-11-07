-- Every ERC-20 transfer in erc20_transfers except one from an address to itself, with what kind of address
-- each side is, the entity each side belongs to, and the transfer's category.
--
-- A side's kind comes from address_labels: exchange, contract or eoa. Two kinds come from the transfers
-- themselves: 'bridge' for the zero address, which mints come from and burns go to, and 'deposit' for an
-- address that is no exchange yet sent every transfer it made on its chain, of any token, to the addresses
-- of one exchange; it takes that exchange's name. A deposit address forwards every token it gets, so a
-- transfer of another token elsewhere rules an address out. A side with no label is 'unknown'.
--
-- A side's entity is its exchange for an exchange or deposit address, bridge:<chain> for the zero address,
-- and the address itself otherwise. Its group is its kind, with a deposit address counted as an exchange.
--
-- category is the first that fits: bridge (a mint or burn), exchange (either side is an exchange or a
-- deposit address), contract (either side is a contract), p2p (both sides are EOAs), else unknown.
with transfers as (
    select * from {{ ref('erc20_transfers') }}
    where from_address <> to_address
),

labels as (
    select chain, address, kind, exchange from {{ ref('address_labels') }}
),

deposits as (
    select t.chain, t.from_address as address, min(l.exchange) as exchange
    from transfers as t
    left join labels as l on l.chain = t.chain and l.address = t.to_address and l.kind = 'exchange'
    left join labels as self on self.chain = t.chain and self.address = t.from_address
    where t.from_address <> '0x0000000000000000000000000000000000000000'
        and coalesce(self.kind, '') <> 'exchange'
    group by t.chain, t.from_address
    having bool_and(l.exchange is not null) and count(distinct l.exchange) = 1
),

sides as (
    select
        t.*,
        case
            when t.from_address = '0x0000000000000000000000000000000000000000' then 'bridge'
            when fd.address is not null then 'deposit'
            else coalesce(fl.kind, 'unknown')
        end as from_kind,
        coalesce(fl.exchange, fd.exchange) as from_exchange,
        case
            when t.to_address = '0x0000000000000000000000000000000000000000' then 'bridge'
            when td.address is not null then 'deposit'
            else coalesce(tl.kind, 'unknown')
        end as to_kind,
        coalesce(tl.exchange, td.exchange) as to_exchange
    from transfers as t
    left join labels as fl on fl.chain = t.chain and fl.address = t.from_address
    left join labels as tl on tl.chain = t.chain and tl.address = t.to_address
    left join deposits as fd on fd.chain = t.chain and fd.address = t.from_address
    left join deposits as td on td.chain = t.chain and td.address = t.to_address
)

select
    chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value,
    from_kind,
    from_exchange,
    case
        when from_kind in ('exchange', 'deposit') then from_exchange
        when from_kind = 'bridge' then 'bridge:' || chain
        else from_address
    end as from_entity,
    case when from_kind = 'deposit' then 'exchange' else from_kind end as from_group,
    to_kind,
    to_exchange,
    case
        when to_kind in ('exchange', 'deposit') then to_exchange
        when to_kind = 'bridge' then 'bridge:' || chain
        else to_address
    end as to_entity,
    case when to_kind = 'deposit' then 'exchange' else to_kind end as to_group,
    case
        when 'bridge' in (from_kind, to_kind) then 'bridge'
        when from_kind in ('exchange', 'deposit') or to_kind in ('exchange', 'deposit') then 'exchange'
        when 'contract' in (from_kind, to_kind) then 'contract'
        when from_kind = 'eoa' and to_kind = 'eoa' then 'p2p'
        else 'unknown'
    end as category
from sides
