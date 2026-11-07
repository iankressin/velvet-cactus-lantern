-- One row per withdrawal from one L2 to Ethereum that a deposit from Ethereum into another L2 can have
-- paid for, per the rule in catalog/protocols/arbitrum-token-bridge/NOTES.md: the same Ethereum address
-- and token, the same amount, and the deposit at least the withdrawal chain's finality delay later
-- (6.4 days from Arbitrum, 1 day from Base, the shortest Base window). Each withdrawal and deposit is used
-- once: within one Ethereum address, token and amount, the nth withdrawal pairs with the nth deposit, in
-- time order. candidates counts the withdrawals that could have paid for the deposit. The pairing infers;
-- the Ethereum side would prove it.
with withdrawals as (
    select
        *,
        block_timestamp + case chain when 'arbitrum' then interval '6.4 days' else interval '1 day' end as ready_at,
        row_number() over (partition by chain, ethereum_address, ethereum_token, amount order by block_timestamp, id) as n
    from {{ ref('bridge_transfers') }}
    where direction = 'to_ethereum'
),

deposits as (
    select
        *,
        row_number() over (partition by chain, ethereum_address, ethereum_token, amount order by block_timestamp, id) as n
    from {{ ref('bridge_transfers') }}
    where direction = 'from_ethereum'
)

select
    w.chain as from_chain,
    w.l2_address as from_address,
    w.ethereum_address,
    d.chain as to_chain,
    d.l2_address as to_address,
    w.ethereum_token,
    w.amount,
    w.id as withdrawal_id,
    w.block_timestamp as withdrawn_at,
    w.tx_hash as withdrawal_tx_hash,
    d.id as deposit_id,
    d.block_timestamp as deposited_at,
    d.tx_hash as deposit_tx_hash,
    (
        select count(*) from withdrawals as c
        where c.ethereum_address = d.ethereum_address and c.ethereum_token = d.ethereum_token
            and c.amount = d.amount and c.chain <> d.chain and c.ready_at <= d.block_timestamp
    ) as candidates
from withdrawals as w
join deposits as d
    on d.ethereum_address = w.ethereum_address
    and d.ethereum_token = w.ethereum_token
    and d.amount = w.amount
    and d.n = w.n
    and d.chain <> w.chain
    and d.block_timestamp >= w.ready_at
