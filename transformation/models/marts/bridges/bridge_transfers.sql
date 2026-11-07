-- One row per token bridge move between an L2 and Ethereum, on every chain whose bridge a source reads:
-- the L2 address, the Ethereum address on the other side, the Ethereum token, and the amount in the
-- token's base units. direction is to_ethereum for a withdrawal, from_ethereum for a deposit.
-- Each bridge's intermediate model brings its rows in this shape, so a new bridge adds one branch.
with moves as (
    select * from {{ ref('int_arbitrum_token_bridge_transfers') }}

    union all

    select * from {{ ref('int_base_op_standard_bridge_transfers') }}
)

select
    chain, id, direction, l2_address, ethereum_address, ethereum_token, l2_token, amount,
    block_number, block_timestamp, tx_hash, log_index
from moves
