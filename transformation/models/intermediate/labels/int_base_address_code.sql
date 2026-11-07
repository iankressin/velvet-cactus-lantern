-- Base addresses with their latest code reading, in the shape address_labels reads. code_kind is
-- 'none' for no code, 'eip7702_delegation' for an EOA that delegates to a contract (code 0xef0100
-- followed by a 20-byte address, EIP-7702), and 'contract' for any other code.
with latest as (
    select distinct on (address) address, block_number, code
    from {{ ref('stg_base__address_code') }}
    order by address, block_number desc
)

select
    'base' as chain,
    address,
    block_number as code_block,
    case
        when code = '0x' then 'none'
        when code ~ '^0xef0100[0-9a-f]{40}$' then 'eip7702_delegation'
        else 'contract'
    end as code_kind
from latest
