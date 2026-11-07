-- The share of the token moved in its windows that went to or came from an exchange or one of its
-- deposit addresses, in percent. token_categories_by_category has every category.
with classified as (
    {{ token_transfers(ref('classified_transfers')) }}
)

select round(100 * sum(value) filter (where category = 'exchange') / sum(value), 2) as exchange_share_pct
from classified
