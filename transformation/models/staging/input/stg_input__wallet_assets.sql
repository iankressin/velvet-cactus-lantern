-- One row per line of the wallet asset CSV, in every load. The cells come as written; wallet and token
-- are the keys the balance tables use, and are null when the line is invalid, as problem then says.
select
    id,
    data ->> 'load_id' as load_id,
    (data ->> 'line')::integer as line,
    data ->> 'blockchain' as blockchain,
    data ->> 'wallet_address' as wallet_address,
    data ->> 'token_address' as token_address,
    data ->> 'asset_type' as asset_type,
    data ->> 'wallet' as wallet,
    data ->> 'token' as token,
    data ->> 'problem' as problem,
    _loaded_at
from {{ source('input', 'wallet_assets') }}
