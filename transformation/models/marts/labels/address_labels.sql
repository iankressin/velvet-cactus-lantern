-- One row per address on each chain whose code a source read: what kind of address it is, and the
-- exchange that owns it when one does. kind is 'exchange' for an address in seeds/cex_addresses,
-- otherwise 'contract' for an address with code, otherwise 'eoa', which includes EIP-7702 delegated
-- EOAs. Each chain's intermediate model brings its rows in this shape, so a new chain adds one branch.
with code as (
    select chain, address, code_block, code_kind from {{ ref('int_arbitrum_address_code') }}

    union all

    select chain, address, code_block, code_kind from {{ ref('int_base_address_code') }}
)

select
    code.chain,
    code.address,
    code.code_block,
    code.code_kind,
    cex.exchange,
    cex.label as exchange_label,
    case
        when cex.address is not null then 'exchange'
        when code.code_kind = 'contract' then 'contract'
        else 'eoa'
    end as kind
from code
left join {{ ref('cex_addresses') }} as cex
    on cex.chain = code.chain
    and lower(cex.address) = code.address
