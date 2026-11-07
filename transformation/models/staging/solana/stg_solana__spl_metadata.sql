-- One mint in the solana spl rows of input/wallet-assets.csv or solana-spl-metadata's addresses.json,
-- read at one finalized slot; null where the chain has no value.
select
    id,
    (data ->> 'slot')::bigint as slot,
    data ->> 'mint' as mint,
    data ->> 'owner_program' as owner_program,
    (data ->> 'decimals')::integer as decimals,
    data ->> 'token_2022_name' as token_2022_name,
    data ->> 'token_2022_symbol' as token_2022_symbol,
    data ->> 'metaplex_name' as metaplex_name,
    data ->> 'metaplex_symbol' as metaplex_symbol,
    _loaded_at
from {{ source('solana', 'spl_metadata') }}
