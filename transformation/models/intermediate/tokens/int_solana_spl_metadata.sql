-- Solana mint metadata readings in the shape the tokens mart reads. The Token-2022 extension names a mint first, then Metaplex.
select
    id,
    'solana' as chain,
    mint as token,
    coalesce(token_2022_name, metaplex_name) as name,
    coalesce(token_2022_symbol, metaplex_symbol) as symbol,
    decimals,
    slot as block_number,
    _loaded_at
from {{ ref('stg_solana__spl_metadata') }}
