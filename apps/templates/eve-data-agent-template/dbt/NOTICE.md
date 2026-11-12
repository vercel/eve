The seeds, model SQL files, schema YAML files, and models/docs.md are adapted
from [dbt-labs/jaffle_shop_duckdb](https://github.com/dbt-labs/jaffle_shop_duckdb),
revision `20cc904370818ceab08cf19f8fd196e9e81def88`, under the Apache 2.0 license in
[LICENSE](./LICENSE). The project configuration and business metadata are specific
to this template. The orders model uses explicit payment-method aggregates, and
customers reuses the order model for lifetime totals. Customer documentation
matches the exposed `customer_lifetime_value` column.
