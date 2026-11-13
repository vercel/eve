select
    id as payment_id,
    order_id,
    payment_method,
    -- Source payments are recorded in cents.
    amount / 100 as amount
from {{ ref('raw_payments') }}
