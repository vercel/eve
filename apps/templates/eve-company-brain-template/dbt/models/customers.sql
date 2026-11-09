with customer_orders as (
    select
        customer_id,
        min(order_date) as first_order,
        max(order_date) as most_recent_order,
        count(*) as number_of_orders,
        sum(amount) as customer_lifetime_value
    from {{ ref('orders') }}
    group by customer_id
)

select
    customers.customer_id,
    customers.first_name,
    customers.last_name,
    customer_orders.first_order,
    customer_orders.most_recent_order,
    customer_orders.number_of_orders,
    customer_orders.customer_lifetime_value
from {{ ref('stg_customers') }} as customers
left join customer_orders
    on customers.customer_id = customer_orders.customer_id
