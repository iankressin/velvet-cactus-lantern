select
    id,
    data,
    _loaded_at
from {{ source('solana', 'spl_metadata') }}
