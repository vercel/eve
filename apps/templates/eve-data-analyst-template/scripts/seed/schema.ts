/**
 * DDL and descriptions for the demo `analytics` schema.
 *
 * @packageDocumentation
 */

/**
 * Comment set on the demo schema, so people browsing the database know it holds disposable demo data.
 *
 * @remarks Informational only. Whether `db:seed` and the deploy step may replace a schema is decided by `replacementBlocker` in `scripts/seed/load.ts`. It requires the {@link DEMO_MARKER_TABLE} marker table, owned by the role running the seed, no tables the seed didn't create, and no objects in other schemas that depend on it.
 */
export const DEMO_SCHEMA_COMMENT =
  "eve-data-analyst demo data. Safe to drop and re-seed with pnpm db:seed.";

/** Marker table the seed creates in the demo schema, recording the data version and when it was generated up to. */
export const DEMO_MARKER_TABLE = "_eve_demo_seed";

/** Bump when the demo schema changes shape. */
export const DEMO_SCHEMA_VERSION = 1;

/**
 * Builds the statements that create every demo table, its indexes, and its descriptions.
 *
 * @param schema - Validated schema name.
 * @returns Statements to run in order inside the seed transaction.
 * @remarks Descriptions matter: describe_schema shows them to the model, so they explain units, exclusions, and traps.
 */
export const demoSchemaStatements = (schema: string): string[] => [
  `CREATE SCHEMA ${schema}`,
  `COMMENT ON SCHEMA ${schema} IS '${DEMO_SCHEMA_COMMENT}'`,
  `CREATE TABLE ${schema}.${DEMO_MARKER_TABLE} (
    version integer NOT NULL,
    anchor_at timestamptz NOT NULL,
    seeded_at timestamptz NOT NULL DEFAULT now()
  )`,
  `COMMENT ON TABLE ${schema}.${DEMO_MARKER_TABLE} IS 'Marker written by pnpm db:seed. Not business data; ignore it in analysis.'`,

  `CREATE TABLE ${schema}.plans (
    plan_id text PRIMARY KEY,
    name text NOT NULL,
    monthly_price_cents integer NOT NULL,
    annual_price_cents integer NOT NULL
  )`,
  `COMMENT ON TABLE ${schema}.plans IS 'Subscription plans and list prices in USD cents.'`,
  `COMMENT ON COLUMN ${schema}.plans.annual_price_cents IS 'Price of a year paid up front, in USD cents (ten months of the monthly price).'`,

  `CREATE TABLE ${schema}.customers (
    customer_id bigint PRIMARY KEY,
    company_name text NOT NULL,
    email_domain text NOT NULL,
    country text NOT NULL,
    industry text NOT NULL,
    segment text NOT NULL,
    acquisition_source text NOT NULL,
    signed_up_at timestamptz NOT NULL,
    is_internal boolean NOT NULL DEFAULT false
  )`,
  `COMMENT ON TABLE ${schema}.customers IS 'One row per account that signed up, paying or not.'`,
  `COMMENT ON COLUMN ${schema}.customers.segment IS 'self_serve (signed up and paid online) or sales (sales-assisted).'`,
  `COMMENT ON COLUMN ${schema}.customers.acquisition_source IS 'web_sessions.source of the session the account signed up in.'`,
  `COMMENT ON COLUMN ${schema}.customers.country IS 'ISO 3166-1 alpha-2 country code.'`,
  `COMMENT ON COLUMN ${schema}.customers.is_internal IS 'Internal QA and test accounts on comped plans. Exclude from every business metric.'`,

  `CREATE TABLE ${schema}.subscriptions (
    subscription_id bigint PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES ${schema}.customers,
    plan_id text NOT NULL REFERENCES ${schema}.plans,
    billing_interval text NOT NULL,
    mrr_cents integer NOT NULL,
    status text NOT NULL,
    trial_started_at timestamptz,
    trial_ends_at timestamptz,
    started_at timestamptz,
    canceled_at timestamptz,
    ended_at timestamptz
  )`,
  `COMMENT ON TABLE ${schema}.subscriptions IS 'One row per period a customer spent on one plan. A plan change ends one row and starts the next at the same instant. Trials that never converted have started_at NULL.'`,
  `COMMENT ON COLUMN ${schema}.subscriptions.billing_interval IS 'month or year.'`,
  `COMMENT ON COLUMN ${schema}.subscriptions.mrr_cents IS 'Normalized monthly recurring revenue in USD cents (annual price / 12 for yearly billing). 0 for trials.'`,
  `COMMENT ON COLUMN ${schema}.subscriptions.status IS 'CURRENT state only (trialing, active, canceled, expired). Never use it for historical questions; use started_at and ended_at.'`,
  `COMMENT ON COLUMN ${schema}.subscriptions.started_at IS 'When paid service began (after the trial). NULL if the trial never converted.'`,
  `COMMENT ON COLUMN ${schema}.subscriptions.canceled_at IS 'When the customer asked to cancel. Service continues until ended_at.'`,
  `COMMENT ON COLUMN ${schema}.subscriptions.ended_at IS 'When this row stopped contributing MRR (cancellation took effect, plan changed, or trial expired). NULL while ongoing; may be in the future for a pending cancellation.'`,

  `CREATE TABLE ${schema}.invoices (
    invoice_id bigint PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES ${schema}.customers,
    subscription_id bigint NOT NULL REFERENCES ${schema}.subscriptions,
    status text NOT NULL,
    total_cents integer NOT NULL,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    issued_at timestamptz NOT NULL
  )`,
  `COMMENT ON TABLE ${schema}.invoices IS 'One invoice per billing period. Annual plans are invoiced once a year for the full year.'`,
  `COMMENT ON COLUMN ${schema}.invoices.status IS 'paid, open (awaiting retry), or uncollectible.'`,
  `COMMENT ON COLUMN ${schema}.invoices.total_cents IS 'Invoice amount in USD cents.'`,

  `CREATE TABLE ${schema}.payments (
    payment_id bigint PRIMARY KEY,
    invoice_id bigint NOT NULL REFERENCES ${schema}.invoices,
    customer_id bigint NOT NULL REFERENCES ${schema}.customers,
    amount_cents integer NOT NULL,
    status text NOT NULL,
    method text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `COMMENT ON TABLE ${schema}.payments IS 'Payment attempts. A failed attempt may be followed by a successful retry for the same invoice.'`,
  `COMMENT ON COLUMN ${schema}.payments.status IS 'succeeded or failed. Only succeeded payments count as revenue.'`,
  `COMMENT ON COLUMN ${schema}.payments.amount_cents IS 'Amount in USD cents.'`,

  `CREATE TABLE ${schema}.refunds (
    refund_id bigint PRIMARY KEY,
    payment_id bigint NOT NULL REFERENCES ${schema}.payments,
    customer_id bigint NOT NULL REFERENCES ${schema}.customers,
    amount_cents integer NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `COMMENT ON TABLE ${schema}.refunds IS 'Full or partial refunds of succeeded payments, dated when refunded.'`,
  `COMMENT ON COLUMN ${schema}.refunds.amount_cents IS 'Refunded amount in USD cents.'`,

  `CREATE TABLE ${schema}.web_sessions (
    session_id bigint PRIMARY KEY,
    anonymous_id text NOT NULL,
    customer_id bigint REFERENCES ${schema}.customers,
    started_at timestamptz NOT NULL,
    landing_page text NOT NULL,
    referrer_domain text,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    source text NOT NULL,
    medium text NOT NULL,
    channel_group text NOT NULL,
    device text NOT NULL,
    country text NOT NULL,
    pageviews integer NOT NULL,
    duration_seconds integer NOT NULL,
    is_bot boolean NOT NULL DEFAULT false
  )`,
  `COMMENT ON TABLE ${schema}.web_sessions IS 'Marketing website sessions. One row per visit.'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.anonymous_id IS 'Cookie ID. Count distinct values for visitors.'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.customer_id IS 'Set on the session in which the account signed up.'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.source IS 'Traffic source (google, (direct), linkedin, newsletter, ...). Use this for "traffic source" questions.'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.medium IS 'organic, cpc, social, paid_social, referral, email, or (none).'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.channel_group IS 'Marketing channel: Organic Search, Paid Search, Direct, Referral, Organic Social, Paid Social, or Email.'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.utm_source IS 'Raw utm_source tag; NULL for untagged traffic. Prefer source.'`,
  `COMMENT ON COLUMN ${schema}.web_sessions.is_bot IS 'Detected bot or crawler traffic. Exclude from every traffic metric.'`,

  `CREATE TABLE ${schema}.signups (
    signup_id bigint PRIMARY KEY,
    session_id bigint NOT NULL REFERENCES ${schema}.web_sessions,
    customer_id bigint NOT NULL REFERENCES ${schema}.customers,
    signed_up_at timestamptz NOT NULL
  )`,
  `COMMENT ON TABLE ${schema}.signups IS 'Product signups, attributed to the web session they happened in.'`,

  `CREATE INDEX ON ${schema}.subscriptions (customer_id)`,
  `CREATE INDEX ON ${schema}.subscriptions (started_at, ended_at)`,
  `CREATE INDEX ON ${schema}.invoices (issued_at)`,
  `CREATE INDEX ON ${schema}.payments (created_at)`,
  `CREATE INDEX ON ${schema}.refunds (created_at)`,
  `CREATE INDEX ON ${schema}.web_sessions (started_at)`,
  `CREATE INDEX ON ${schema}.signups (signed_up_at)`,
];

/** Tables `db:seed` creates, besides its {@link DEMO_MARKER_TABLE} marker. */
export const DEMO_TABLES = [
  "plans",
  "customers",
  "subscriptions",
  "invoices",
  "payments",
  "refunds",
  "web_sessions",
  "signups",
];
