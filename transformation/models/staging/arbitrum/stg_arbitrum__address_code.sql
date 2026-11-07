-- The code at one address in chains/arbitrum/addresses.json of evm-address-code, read at one block, as
-- eth_getCode returned it: '0x' when the address has none.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'address') as address,
    data ->> 'code' as code,
    _loaded_at
from {{ source('arbitrum', 'address_code') }}
