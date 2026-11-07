-- Each contract and every address that sent it the token or got the token from it, most moved first.
-- Only transfers whose category is contract: a contract's transfers with an exchange count as exchange
-- transfers.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
),

legs as (
    select chain, to_address as contract, from_address as counterparty, from_kind as counterparty_kind,
        value as amount_in, 0 as amount_out, 1 as transfers_in, 0 as transfers_out
    from classified
    where category = 'contract' and to_kind = 'contract'

    union all

    select chain, from_address, to_address, to_kind, 0, value, 0, 1
    from classified
    where category = 'contract' and from_kind = 'contract'
)

select
    chain,
    contract,
    counterparty,
    counterparty_kind,
    round(sum(amount_in) / {{ token_unit() }}, 6) as amount_to_contract,
    round(sum(amount_out) / {{ token_unit() }}, 6) as amount_from_contract,
    sum(transfers_in) as transfers_to_contract,
    sum(transfers_out) as transfers_from_contract
from legs
group by chain, contract, counterparty, counterparty_kind
order by sum(sum(amount_in + amount_out)) over (partition by chain, contract) desc, contract, sum(amount_in + amount_out) desc, counterparty
