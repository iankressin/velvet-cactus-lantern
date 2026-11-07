-- Base's standard bridge moves in the shape bridge_transfers reads, per
-- catalog/protocols/op-standard-bridge/NOTES.md. An ERC20BridgeInitiated sends the token from the L2
-- user `from` to the Ethereum address `to`; an ERC20BridgeFinalized brings it from the Ethereum address
-- `from` to the L2 user `to`. localToken is the Base token, remoteToken the Ethereum one.
select
    id,
    'base' as chain,
    case event when 'ERC20BridgeInitiated' then 'to_ethereum' else 'from_ethereum' end as direction,
    case event when 'ERC20BridgeInitiated' then from_address else to_address end as l2_address,
    case event when 'ERC20BridgeInitiated' then to_address else from_address end as ethereum_address,
    remote_token as ethereum_token,
    local_token as l2_token,
    amount,
    block_number,
    block_timestamp,
    tx_hash,
    log_index
from {{ ref('stg_base__op_standard_bridge') }}
