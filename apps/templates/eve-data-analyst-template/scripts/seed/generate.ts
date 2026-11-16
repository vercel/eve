/**
 * Deterministic demo data for a SaaS company: plans, customers, subscriptions, billing, and web traffic.
 *
 * @packageDocumentation
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Days of history generated before the anchor. */
export const HISTORY_DAYS = 548;

/** One subscription plan. */
interface PlanRow {
  readonly annual_price_cents: number;
  readonly monthly_price_cents: number;
  readonly name: string;
  readonly plan_id: string;
}

/** One customer account. */
interface CustomerRow {
  readonly acquisition_source: string;
  readonly company_name: string;
  readonly country: string;
  readonly customer_id: number;
  readonly email_domain: string;
  readonly industry: string;
  readonly is_internal: boolean;
  readonly segment: "sales" | "self_serve";
  readonly signed_up_at: Date;
}

/** One subscription period on one plan; plan changes end one row and start the next. */
interface SubscriptionRow {
  readonly billing_interval: "month" | "year";
  readonly canceled_at: Date | null;
  readonly customer_id: number;
  readonly ended_at: Date | null;
  readonly mrr_cents: number;
  readonly plan_id: string;
  readonly started_at: Date | null;
  readonly status: "active" | "canceled" | "expired" | "trialing";
  readonly subscription_id: number;
  readonly trial_ends_at: Date | null;
  readonly trial_started_at: Date | null;
}

/** One invoice for one billing period. */
interface InvoiceRow {
  readonly customer_id: number;
  readonly invoice_id: number;
  readonly issued_at: Date;
  readonly period_end: Date;
  readonly period_start: Date;
  readonly status: "open" | "paid" | "uncollectible";
  readonly subscription_id: number;
  readonly total_cents: number;
}

/** One payment attempt against an invoice. */
interface PaymentRow {
  readonly amount_cents: number;
  readonly created_at: Date;
  readonly customer_id: number;
  readonly invoice_id: number;
  readonly method: "ach" | "card" | "wire";
  readonly payment_id: number;
  readonly status: "failed" | "succeeded";
}

/** One refund of a succeeded payment. */
interface RefundRow {
  readonly amount_cents: number;
  readonly created_at: Date;
  readonly customer_id: number;
  readonly payment_id: number;
  readonly reason: string;
  readonly refund_id: number;
}

/** One website session; `db:seed` derives `anonymous_id` and `duration_seconds` in SQL to keep the upload small. */
interface WebSessionRow {
  readonly channel_group: string;
  readonly country: string;
  readonly customer_id: number | null;
  readonly device: string;
  readonly is_bot: boolean;
  readonly landing_page: string;
  readonly medium: string;
  readonly pageviews: number;
  readonly referrer_domain: string | null;
  readonly session_id: number;
  readonly source: string;
  readonly started_at: Date;
  readonly utm_campaign: string | null;
  readonly utm_medium: string | null;
  readonly utm_source: string | null;
}

/** One product signup attributed to the session it happened in. */
interface SignupRow {
  readonly customer_id: number;
  readonly session_id: number;
  readonly signed_up_at: Date;
  readonly signup_id: number;
}

/** Every generated table. */
export interface DemoData {
  readonly anchor: Date;
  readonly customers: CustomerRow[];
  readonly invoices: InvoiceRow[];
  readonly payments: PaymentRow[];
  readonly plans: PlanRow[];
  readonly refunds: RefundRow[];
  readonly signups: SignupRow[];
  readonly subscriptions: SubscriptionRow[];
  readonly webSessions: WebSessionRow[];
}

const MODULUS = 2_147_483_647;

/* Park-Miller minimal standard generator: exact in double precision, so identical on every platform. */
const createRandom = (seed: number) => {
  let state = (Math.abs(Math.trunc(seed)) % (MODULUS - 1)) + 1;
  return (): number => {
    state = (state * 48_271) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
};

type Random = ReturnType<typeof createRandom>;

const pick = <T>(random: Random, items: readonly T[]): T => {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error("Cannot pick from an empty list.");
  }
  return item;
};

const weighted = <T>(
  random: Random,
  items: readonly (readonly [T, number])[]
): T => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) {
      return item;
    }
  }
  const last = items.at(-1);
  if (!last) {
    throw new Error("Cannot pick from an empty list.");
  }
  return last[0];
};

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

const addMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const min = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

/** Plans and list prices; annual billing is ten months' price paid up front. */
const PLANS: readonly PlanRow[] = [
  {
    annual_price_cents: 29_000,
    monthly_price_cents: 2900,
    name: "Starter",
    plan_id: "starter",
  },
  {
    annual_price_cents: 99_000,
    monthly_price_cents: 9900,
    name: "Growth",
    plan_id: "growth",
  },
  {
    annual_price_cents: 299_000,
    monthly_price_cents: 29_900,
    name: "Scale",
    plan_id: "scale",
  },
  {
    annual_price_cents: 1_500_000,
    monthly_price_cents: 150_000,
    name: "Enterprise",
    plan_id: "enterprise",
  },
];

const UPGRADE = new Map([
  ["growth", "scale"],
  ["starter", "growth"],
]);

interface TrafficSource {
  readonly campaign: string | null;
  readonly channel: string;
  readonly medium: string;
  readonly referrer: string | null;
  readonly source: string;
  readonly utm: boolean;
}

const traffic = (
  source: string,
  medium: string,
  channel: string,
  referrer: string | null,
  campaign: string | null = null
): TrafficSource => ({
  campaign,
  channel,
  medium,
  referrer,
  source,
  utm: campaign !== null,
});

const GOOGLE_ORGANIC = traffic(
  "google",
  "organic",
  "Organic Search",
  "google.com"
);
const GOOGLE_CPC = traffic(
  "google",
  "cpc",
  "Paid Search",
  "google.com",
  "brand_search"
);
const DIRECT = traffic("(direct)", "(none)", "Direct", null);
const NEWSLETTER = traffic(
  "newsletter",
  "email",
  "Email",
  null,
  "weekly_digest"
);
const PRODUCT_HUNT = traffic(
  "producthunt",
  "referral",
  "Referral",
  "producthunt.com",
  "launch"
);

/* Base share of non-bot sessions by source; Google (organic and paid) stays clearly on top. */
const SOURCE_WEIGHTS: readonly (readonly [TrafficSource, number])[] = [
  [GOOGLE_ORGANIC, 30],
  [GOOGLE_CPC, 11],
  [DIRECT, 17],
  [traffic("linkedin", "social", "Organic Social", "linkedin.com"), 7],
  [traffic("chatgpt.com", "referral", "Referral", "chatgpt.com"), 5],
  [traffic("twitter", "social", "Organic Social", "x.com"), 4],
  [traffic("bing", "organic", "Organic Search", "bing.com"), 4],
  [traffic("github", "referral", "Referral", "github.com"), 4],
  [traffic("reddit", "social", "Organic Social", "reddit.com"), 3],
  [
    traffic(
      "facebook",
      "paid_social",
      "Paid Social",
      "facebook.com",
      "retargeting"
    ),
    3,
  ],
  [traffic("duckduckgo", "organic", "Organic Search", "duckduckgo.com"), 2],
  [NEWSLETTER, 4],
];

const LANDING_PAGES = [
  "/",
  "/pricing",
  "/blog/metrics-that-matter",
  "/docs",
  "/features",
  "/customers",
  "/blog/sql-for-founders",
];
const COUNTRIES: readonly (readonly [string, number])[] = [
  ["US", 45],
  ["GB", 10],
  ["DE", 7],
  ["CA", 6],
  ["AU", 5],
  ["FR", 5],
  ["IN", 8],
  ["BR", 4],
  ["NL", 3],
  ["JP", 3],
  ["SG", 2],
  ["SE", 2],
];
const DEVICES: readonly (readonly [string, number])[] = [
  ["desktop", 62],
  ["mobile", 33],
  ["tablet", 5],
];
const INDUSTRIES = [
  "Software",
  "Fintech",
  "E-commerce",
  "Healthcare",
  "Education",
  "Media",
  "Logistics",
  "Marketing",
  "Real estate",
  "Manufacturing",
];
const NAME_PREFIXES = [
  "Acme",
  "Bright",
  "Cobalt",
  "Delta",
  "Ember",
  "Fable",
  "Granite",
  "Harbor",
  "Iris",
  "Juniper",
  "Kite",
  "Lumen",
  "Maple",
  "Nimbus",
  "Orbit",
  "Pioneer",
  "Quarry",
  "Ridge",
  "Summit",
  "Tidal",
  "Umber",
  "Vertex",
  "Willow",
  "Zephyr",
];
const NAME_SUFFIXES = [
  "Labs",
  "Systems",
  "Analytics",
  "Works",
  "Cloud",
  "Health",
  "Logistics",
  "Studio",
  "Partners",
  "Digital",
  "Commerce",
  "AI",
];

/* Sessions per day grow from about 300 to about 900, softer at weekends, with a launch spike. */
const sessionsOn = (random: Random, day: number, date: Date) => {
  const growth = 300 + (600 * day) / HISTORY_DAYS;
  const weekday = date.getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.68 : 1;
  const sinceLaunch = day - (HISTORY_DAYS - 270);
  const launch =
    sinceLaunch >= 0 && sinceLaunch < 5 ? 2.6 - sinceLaunch * 0.35 : 1;
  return Math.round(growth * weekend * launch * (0.9 + random() * 0.2));
};

const sourceFor = (random: Random, day: number, date: Date): TrafficSource => {
  const sinceLaunch = day - (HISTORY_DAYS - 270);
  if (sinceLaunch >= 0 && sinceLaunch < 5 && random() < 0.45) {
    return PRODUCT_HUNT;
  }
  // The weekly newsletter goes out on Tuesdays.
  if (date.getUTCDay() === 2 && random() < 0.08) {
    return NEWSLETTER;
  }
  return weighted(random, SOURCE_WEIGHTS);
};

const companyName = (random: Random, id: number) =>
  `${pick(random, NAME_PREFIXES)} ${pick(random, NAME_SUFFIXES)}${id % 7 === 0 ? ` ${id}` : ""}`;

const domainFor = (name: string, id: number) =>
  `${name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "")}${id}.example`;

interface Builder {
  readonly anchor: Date;
  readonly data: DemoData;
  readonly ids: {
    invoice: number;
    payment: number;
    refund: number;
    session: number;
    subscription: number;
  };
  readonly random: Random;
}

const priceFor = (planId: string, interval: "month" | "year") => {
  const plan = PLANS.find((candidate) => candidate.plan_id === planId);
  if (!plan) {
    throw new Error(`Unknown plan ${planId}.`);
  }
  return interval === "year"
    ? {
        mrr: Math.round(plan.annual_price_cents / 12),
        total: plan.annual_price_cents,
      }
    : { mrr: plan.monthly_price_cents, total: plan.monthly_price_cents };
};

const bill = (
  builder: Builder,
  subscription: SubscriptionRow,
  from: Date,
  until: Date
) => {
  const { anchor, data, ids, random } = builder;
  if (!subscription.started_at) {
    return;
  }
  const months = subscription.billing_interval === "year" ? 12 : 1;
  const { total } = priceFor(
    subscription.plan_id,
    subscription.billing_interval
  );
  for (
    let start = from;
    start.getTime() < until.getTime() && start.getTime() <= anchor.getTime();
    start = addMonths(start, months)
  ) {
    ids.invoice += 1;
    const invoiceId = ids.invoice;
    const method =
      subscription.plan_id === "enterprise"
        ? "wire"
        : weighted(random, [
            ["card", 88],
            ["ach", 12],
          ] as const);
    const firstFails = random() < 0.03;
    const recovers = random() < 0.7;
    let status: InvoiceRow["status"] = "paid";
    ids.payment += 1;
    data.payments.push({
      amount_cents: total,
      created_at: new Date(start.getTime() + 5 * MINUTE_MS),
      customer_id: subscription.customer_id,
      invoice_id: invoiceId,
      method,
      payment_id: ids.payment,
      status: firstFails ? "failed" : "succeeded",
    });
    let paidPaymentId: number | null = firstFails ? null : ids.payment;
    let paidAt = new Date(start.getTime() + 5 * MINUTE_MS);
    if (firstFails) {
      const retryAt = addDays(start, 3);
      if (retryAt.getTime() > anchor.getTime()) {
        status = "open";
      } else if (recovers) {
        ids.payment += 1;
        data.payments.push({
          amount_cents: total,
          created_at: retryAt,
          customer_id: subscription.customer_id,
          invoice_id: invoiceId,
          method,
          payment_id: ids.payment,
          status: "succeeded",
        });
        paidPaymentId = ids.payment;
        paidAt = retryAt;
      } else {
        status = "uncollectible";
      }
    }
    data.invoices.push({
      customer_id: subscription.customer_id,
      invoice_id: invoiceId,
      issued_at: start,
      period_end: addMonths(start, months),
      period_start: start,
      status,
      subscription_id: subscription.subscription_id,
      total_cents: total,
    });
    if (paidPaymentId !== null && random() < 0.02) {
      const refundAt = addDays(paidAt, 1 + Math.floor(random() * 14));
      if (refundAt.getTime() <= anchor.getTime()) {
        ids.refund += 1;
        data.refunds.push({
          amount_cents: random() < 0.7 ? total : Math.round(total / 2),
          created_at: refundAt,
          customer_id: subscription.customer_id,
          payment_id: paidPaymentId,
          reason: pick(random, [
            "requested_by_customer",
            "duplicate",
            "service_issue",
          ]),
          refund_id: ids.refund,
        });
      }
    }
  }
};

interface PaidLifetime {
  readonly cancelAt: Date;
  readonly periods: readonly PaidPeriod[];
}

interface PaidPeriod {
  readonly end: Date;
  readonly last: boolean;
  readonly plan: string;
  readonly start: Date;
}

/* Plan periods for a converted trial: months until cancellation, with an optional upgrade partway through. */
const paidPeriods = (
  random: Random,
  planId: string,
  interval: "month" | "year",
  paidFrom: Date
): PaidLifetime => {
  // Monthly plans churn about 3% a month; annual plans decide at each renewal.
  const step = interval === "year" ? 12 : 1;
  const churnChance = interval === "year" ? 0.18 : 0.03;
  let lifetimeMonths = step;
  while (random() >= churnChance && lifetimeMonths < 120) {
    lifetimeMonths += step;
  }
  const endAt = addMonths(paidFrom, lifetimeMonths);
  const cancelAt = addDays(endAt, -1 - Math.floor(random() * 20));
  const nextPlan = UPGRADE.get(planId);
  if (
    !nextPlan ||
    interval === "year" ||
    lifetimeMonths <= 2 ||
    random() >= 0.3
  ) {
    return {
      cancelAt,
      periods: [{ end: endAt, last: true, plan: planId, start: paidFrom }],
    };
  }
  const upgradeAt = addMonths(
    paidFrom,
    1 + Math.floor(random() * (lifetimeMonths - 1))
  );
  return {
    cancelAt,
    periods: [
      { end: upgradeAt, last: false, plan: planId, start: paidFrom },
      { end: endAt, last: true, plan: nextPlan, start: upgradeAt },
    ],
  };
};

/* A trial that never converted, or is still running. */
const recordTrial = (
  builder: Builder,
  customer: CustomerRow,
  trialStart: Date,
  plan: { readonly id: string; readonly interval: "month" | "year" }
) => {
  const { anchor, data, ids } = builder;
  const trialEnd = addDays(trialStart, 14);
  const trialing = trialEnd.getTime() > anchor.getTime();
  ids.subscription += 1;
  data.subscriptions.push({
    billing_interval: plan.interval,
    canceled_at: null,
    customer_id: customer.customer_id,
    ended_at: trialing ? null : trialEnd,
    mrr_cents: 0,
    plan_id: plan.id,
    started_at: null,
    status: trialing ? "trialing" : "expired",
    subscription_id: ids.subscription,
    trial_ends_at: trialEnd,
    trial_started_at: trialStart,
  });
};

/* A converted trial: one subscription row per plan period, billed until it ends or the anchor. */
const subscribe = (
  builder: Builder,
  customer: CustomerRow,
  trialStart: Date,
  converts: boolean
) => {
  const { anchor, data, ids, random } = builder;
  const trialEnd = addDays(trialStart, 14);
  const segmentPlans: readonly (readonly [string, number])[] =
    customer.segment === "sales"
      ? [
          ["scale", 55],
          ["enterprise", 45],
        ]
      : [
          ["starter", 55],
          ["growth", 36],
          ["scale", 9],
        ];
  const planId = weighted(random, segmentPlans);
  const interval: "month" | "year" =
    planId === "enterprise" || random() < 0.22 ? "year" : "month";
  if (!converts || trialEnd.getTime() > anchor.getTime()) {
    recordTrial(builder, customer, trialStart, { id: planId, interval });
    return;
  }
  const { cancelAt, periods } = paidPeriods(random, planId, interval, trialEnd);
  for (const [index, period] of periods.entries()) {
    if (period.start.getTime() > anchor.getTime()) {
      break;
    }
    const ended = period.end.getTime() <= anchor.getTime();
    const canceledVisible =
      period.last && cancelAt.getTime() <= anchor.getTime();
    ids.subscription += 1;
    // Cancellations take effect at period end, so a canceled subscription can still be paying.
    const subscription: SubscriptionRow = {
      billing_interval: interval,
      canceled_at: canceledVisible ? cancelAt : null,
      customer_id: customer.customer_id,
      ended_at: ended || canceledVisible || !period.last ? period.end : null,
      mrr_cents: priceFor(period.plan, interval).mrr,
      plan_id: period.plan,
      started_at: period.start,
      status: ended ? "canceled" : "active",
      subscription_id: ids.subscription,
      trial_ends_at: index === 0 ? trialEnd : null,
      trial_started_at: index === 0 ? trialStart : null,
    };
    data.subscriptions.push(subscription);
    bill(builder, subscription, period.start, min(period.end, anchor));
  }
};

const internalAccounts = (builder: Builder, start: Date) => {
  const { data, ids } = builder;
  for (let index = 1; index <= 12; index += 1) {
    const customerId = data.customers.length + 1;
    const signedUpAt = addDays(start, 20 + index);
    data.customers.push({
      acquisition_source: "(internal)",
      company_name: `Internal QA ${index}`,
      country: "US",
      customer_id: customerId,
      email_domain: "internal.example",
      industry: "Software",
      is_internal: true,
      segment: "sales",
      signed_up_at: signedUpAt,
    });
    // Test accounts on comped Enterprise plans: excluding them is part of every metric.
    ids.subscription += 1;
    data.subscriptions.push({
      billing_interval: "year",
      canceled_at: null,
      customer_id: customerId,
      ended_at: null,
      mrr_cents: 125_000,
      plan_id: "enterprise",
      started_at: signedUpAt,
      status: "active",
      subscription_id: ids.subscription,
      trial_ends_at: null,
      trial_started_at: null,
    });
  }
};

/* Records one website session and, for a small share of human visits, a signup with its trial. */
const visit = (builder: Builder, startedAt: Date, organic: TrafficSource) => {
  const { anchor, data, ids, random } = builder;
  ids.session += 1;
  const isBot = random() < 0.03;
  const source = isBot && random() < 0.8 ? DIRECT : organic;
  const pageviews = isBot ? 1 : 1 + Math.floor(random() ** 2 * 9);
  const signsUp = !isBot && random() < 0.018;
  const customerId = signsUp ? data.customers.length + 1 : null;
  data.webSessions.push({
    channel_group: source.channel,
    country: weighted(random, COUNTRIES),
    customer_id: customerId,
    device: isBot ? "desktop" : weighted(random, DEVICES),
    is_bot: isBot,
    landing_page:
      source === NEWSLETTER
        ? "/blog/metrics-that-matter"
        : pick(random, LANDING_PAGES),
    medium: source.medium,
    pageviews,
    referrer_domain: source.referrer,
    session_id: ids.session,
    source: source.source,
    started_at: startedAt,
    utm_campaign: source.utm ? source.campaign : null,
    utm_medium: source.utm ? source.medium : null,
    utm_source: source.utm ? source.source : null,
  });
  if (customerId === null) {
    return;
  }
  const signedUpAt = new Date(
    Math.min(
      startedAt.getTime() + Math.floor(random() * 20 * MINUTE_MS),
      anchor.getTime()
    )
  );
  const name = companyName(random, customerId);
  const customer: CustomerRow = {
    acquisition_source: source.source,
    company_name: name,
    country: weighted(random, COUNTRIES),
    customer_id: customerId,
    email_domain: domainFor(name, customerId),
    industry: pick(random, INDUSTRIES),
    is_internal: false,
    segment: random() < 0.08 ? "sales" : "self_serve",
    signed_up_at: signedUpAt,
  };
  data.customers.push(customer);
  data.signups.push({
    customer_id: customerId,
    session_id: ids.session,
    signed_up_at: signedUpAt,
    signup_id: data.signups.length + 1,
  });
  const conversion = customer.segment === "sales" ? 0.4 : 0.22;
  subscribe(builder, customer, signedUpAt, random() < conversion);
};

/**
 * Generates the demo dataset.
 *
 * @param options - The latest instant to generate data for (`anchor`; history covers the preceding 548 days) and an optional PRNG `seed`. The same anchor and seed always produce identical data.
 * @returns Rows for every demo table.
 */
export const generateDemoData = ({
  anchor,
  seed = 42,
}: {
  readonly anchor: Date;
  readonly seed?: number;
}): DemoData => {
  const random = createRandom(seed);
  const start = new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate()
    ) -
      HISTORY_DAYS * DAY_MS
  );
  const data: DemoData = {
    anchor,
    customers: [],
    invoices: [],
    payments: [],
    plans: [...PLANS],
    refunds: [],
    signups: [],
    subscriptions: [],
    webSessions: [],
  };
  const builder: Builder = {
    anchor,
    data,
    ids: { invoice: 0, payment: 0, refund: 0, session: 0, subscription: 0 },
    random,
  };
  internalAccounts(builder, start);
  for (let day = 0; day <= HISTORY_DAYS; day += 1) {
    const date = addDays(start, day);
    const count = sessionsOn(random, day, date);
    for (let index = 0; index < count; index += 1) {
      const startedAt = new Date(
        date.getTime() + Math.floor(random() * 24 * HOUR_MS)
      );
      if (startedAt.getTime() <= anchor.getTime()) {
        visit(builder, startedAt, sourceFor(random, day, date));
      }
    }
  }
  return data;
};
