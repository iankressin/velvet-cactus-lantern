-- Each exchange and every wallet that sent it the token or got the token from it, most moved first.
-- wallet_kind says what the other side is: eoa, contract, or another exchange or its deposit address.
-- An exchange includes its inferred deposit addresses, so a wallet that paid into a deposit address shows
-- here, and moves between one exchange's own addresses do not.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
),

legs as (
    select chain, to_exchange as exchange, to_kind as exchange_side, from_address as wallet, from_kind as wallet_kind,
        from_exchange as wallet_exchange, value as amount_in, 0 as amount_out, 1 as transfers_in, 0 as transfers_out
    from classified
    where to_kind in ('exchange', 'deposit') and from_exchange is distinct from to_exchange

    union all

    select chain, from_exchange, from_kind, to_address, to_kind, to_exchange, 0, value, 0, 1
    from classified
    where from_kind in ('exchange', 'deposit') and to_exchange is distinct from from_exchange
)

select
    exchange,
    chain,
    wallet,
    wallet_kind,
    wallet_exchange,
    round(sum(amount_in) / {{ token_unit() }}, 6) as amount_to_exchange,
    round(sum(amount_out) / {{ token_unit() }}, 6) as amount_from_exchange,
    sum(transfers_in) as transfers_to_exchange,
    sum(transfers_out) as transfers_from_exchange,
    bool_or(exchange_side = 'deposit') as through_deposit_address
from legs
group by exchange, chain, wallet, wallet_kind, wallet_exchange
order by exchange, sum(amount_in + amount_out) desc, wallet
