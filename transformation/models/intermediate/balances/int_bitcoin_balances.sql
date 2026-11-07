-- BTC balances in the shape latest_balances reads. Balance is in satoshis.
select
    id,
    'bitcoin' as chain,
    wallet,
    'native' as asset_type,
    'btc' as asset,
    block_number,
    balance,
    _loaded_at
from {{ ref('stg_bitcoin__btc_balances') }}
