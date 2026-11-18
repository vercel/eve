import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateDemoData, HISTORY_DAYS } from "./generate";
import type { DemoData } from "./generate";

const DAY_MS = 86_400_000;
const anchor = new Date("2026-10-10T08:00:00.000Z");
const data = generateDemoData({ anchor });
const internal = new Set(
  data.customers
    .filter((customer) => customer.is_internal)
    .map((customer) => customer.customer_id)
);

const hash = (value: DemoData) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const mrrAt = (at: Date, includeInternal = false) =>
  data.subscriptions
    .filter(
      (subscription) =>
        subscription.started_at !== null &&
        subscription.started_at < at &&
        (subscription.ended_at === null || subscription.ended_at >= at) &&
        (includeInternal || !internal.has(subscription.customer_id))
    )
    .reduce((sum, subscription) => sum + subscription.mrr_cents, 0);

describe(generateDemoData, () => {
  it("is deterministic for an anchor and seed", () => {
    expect(hash(generateDemoData({ anchor }))).toBe(hash(data));
    expect(hash(generateDemoData({ anchor, seed: 7 }))).not.toBe(hash(data));
  });

  it("covers the history window and never passes the anchor", () => {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const session of data.webSessions) {
      earliest = Math.min(earliest, session.started_at.getTime());
      latest = Math.max(latest, session.started_at.getTime());
    }
    expect(earliest).toBeGreaterThanOrEqual(
      anchor.getTime() - (HISTORY_DAYS + 1) * DAY_MS
    );
    expect(latest).toBeLessThanOrEqual(anchor.getTime());
    for (const table of [data.payments, data.refunds]) {
      expect(table.every((row) => row.created_at <= anchor)).toBe(true);
    }
  });

  it("has recurring revenue last month and visibly more when internal accounts are included", () => {
    const monthStart = new Date("2026-10-01T00:00:00.000Z");
    const mrr = mrrAt(monthStart);
    expect(mrr).toBeGreaterThan(5_000_000);
    expect(mrrAt(monthStart, true) / mrr).toBeGreaterThan(1.05);
  });

  it("makes google the clear top source over the last 10 days", () => {
    const from = new Date("2026-09-30T00:00:00.000Z");
    const to = new Date("2026-10-10T00:00:00.000Z");
    const counts = new Map<string, number>();
    for (const session of data.webSessions) {
      if (
        !session.is_bot &&
        session.started_at >= from &&
        session.started_at < to
      ) {
        counts.set(session.source, (counts.get(session.source) ?? 0) + 1);
      }
    }
    const [first, second] = [...counts.entries()].toSorted(
      (a, b) => b[1] - a[1]
    );
    expect(first?.[0]).toBe("google");
    expect((first?.[1] ?? 0) / (second?.[1] ?? 1)).toBeGreaterThan(1.5);
  });

  it("keeps references and money consistent", () => {
    const customers = new Set(
      data.customers.map((customer) => customer.customer_id)
    );
    const sessions = new Set(
      data.webSessions.map((session) => session.session_id)
    );
    const invoices = new Set(
      data.invoices.map((invoice) => invoice.invoice_id)
    );
    const payments = new Set(
      data.payments.map((payment) => payment.payment_id)
    );
    expect(
      data.subscriptions.every(
        (row) => customers.has(row.customer_id) && row.mrr_cents >= 0
      )
    ).toBe(true);
    expect(
      data.signups.every(
        (row) => customers.has(row.customer_id) && sessions.has(row.session_id)
      )
    ).toBe(true);
    expect(
      data.payments.every(
        (row) => invoices.has(row.invoice_id) && row.amount_cents > 0
      )
    ).toBe(true);
    expect(data.refunds.every((row) => payments.has(row.payment_id))).toBe(
      true
    );
    expect(internal.size).toBe(12);
    expect(
      new Set(data.subscriptions.map((row) => row.subscription_id)).size
    ).toBe(data.subscriptions.length);
  });

  it("keeps trials out of MRR and marks paid rows with a start", () => {
    for (const row of data.subscriptions) {
      expect(row.started_at === null ? row.mrr_cents : 1).toBeGreaterThan(-1);
      if (row.started_at === null) {
        expect(row.mrr_cents).toBe(0);
        expect(["trialing", "expired"]).toContain(row.status);
      }
    }
  });
});
