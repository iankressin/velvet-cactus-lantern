{#- The transfers of var('token') in its windows, read from `relation`: erc20_transfers unless given. -#}
{%- macro token_transfers(relation=none) %}
    {%- set relation = relation or ref('erc20_transfers') %}
    {%- for w in var('token').windows %}
    select *
    from {{ relation }}
    where chain = '{{ w.chain }}'
        and token = '{{ w.token | lower }}'
        and block_number between {{ w.blocks[0] }} and {{ w.blocks[1] }}
    {%- if not loop.last %}
    union all
    {%- endif %}
    {%- endfor %}
{%- endmacro %}

{%- macro token_bridge_transfers() %}
    select *
    from {{ ref('bridge_transfers') }}
    where ethereum_token = '{{ var('token').ethereum | lower }}'
        and (
            {%- for w in var('token').windows %}
            (chain = '{{ w.chain }}' and block_number between {{ w.blocks[0] }} and {{ w.blocks[1] }})
            {%- if not loop.last %} or{% endif %}
            {%- endfor %}
        )
{%- endmacro %}

{%- macro token_unit() %}power(10::numeric, {{ var('token').decimals }}){% endmacro %}
