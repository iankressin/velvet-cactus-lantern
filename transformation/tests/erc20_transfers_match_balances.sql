-- Between two consecutive balance readings of a wallet and token, the balance must change by the
-- transfers into the wallet minus those out of it, over the blocks after the first reading up to the
-- second. macros/erc20_balance_pairs.sql picks the pairs of readings inside the blocks
-- ethereum.erc20_transfers has loaded; erc20_transfers_match_balances_has_pairs.sql warns when it finds none.
with pairs as (
    {{ erc20_balance_pairs() }}
)

select
    r.wallet,
    r.token,
    r.from_block,
    r.to_block,
    r.balance_change,
    sum(case when t.to_address = r.wallet then t.value else 0 end)
    - sum(case when t.from_address = r.wallet then t.value else 0 end) as net_transfers,
    count(t.id) as transfers
from pairs as r
left join {{ ref('erc20_transfers') }} as t
    on t.chain = 'ethereum'
    and t.token = r.token
    and r.wallet in (t.from_address, t.to_address)
    and t.block_number > r.from_block
    and t.block_number <= r.to_block
group by r.wallet, r.token, r.from_block, r.to_block, r.balance_change
having r.balance_change
    <> sum(case when t.to_address = r.wallet then t.value else 0 end)
    - sum(case when t.from_address = r.wallet then t.value else 0 end)
