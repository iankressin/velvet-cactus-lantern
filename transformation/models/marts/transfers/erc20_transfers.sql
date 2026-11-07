-- Every ERC-20 transfer each chain's source loaded, one row per Transfer log, in the token's base units.
-- `id` is the log's place on its chain, so a row is unique by chain and id.
-- Each chain's intermediate model brings its rows in this shape, so a new chain adds one branch.
select chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value
from {{ ref('int_ethereum_erc20_transfers') }}

union all

select chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value
from {{ ref('int_arbitrum_erc20_transfers') }}

union all

select chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value
from {{ ref('int_base_erc20_transfers') }}
