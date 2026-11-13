import { afterEach, describe, expect, it, vi } from "vitest";

import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";

const oidcToken = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
).toString("base64url")}.signature`;

const context: ScheduleProviderContext = {
  abortSignal: new AbortController().signal,
  collection: "collection",
  namespace: "eve-namespace",
  operationId: "operation_1",
  target: { key: "dynamic-schedules" },
};

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: 1,
    expression: { type: "cron", cron: "0 12 * * *" },
    name: "review-prs-daily",
    scheduleId: "sch_1",
    state: "active",
    timezone: "America/New_York",
    updatedAt: 2,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vercelScheduleProvider", () => {
  it.each(["production", "preview", "staging", "local"] as const)(
    "creates a queue-target schedule with an eve dispatch envelope in %s",
    async (environment) => {
      const local = environment === "local";
      vi.stubEnv("VERCEL", local ? undefined : "1");
      vi.stubEnv("VERCEL_ENV", local ? "development" : environment);
      vi.stubEnv("EVE_DEV", local ? "1" : undefined);
      vi.stubEnv("NODE_ENV", local ? "development" : "test");
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", local ? undefined : `dpl_${environment}`);
      vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
      vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", local ? "1" : undefined);
      vi.stubEnv("VERCEL_SCHEDULE_BASE_URL", local ? "http://127.0.0.1:4784" : undefined);
      vi.stubEnv("VERCEL_SCHEDULE_TOKEN", local ? "local-token" : undefined);
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(schedule()));
      const provider = vercelScheduleProvider({ fetch: fetchImpl });

      const record = await provider.create(context, {
        expression: {
          type: "cron",
          cron: "0 12 * * *",
          timezone: "America/New_York",
          jitter: 5,
        },
        payload: "Review PRs",
        name: "review-prs-daily",
      });

      expect(provider.kind).toBe("vercel");
      expect(record).toMatchObject({ name: "review-prs-daily", scheduleId: "sch_1" });
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe(
        `${local ? "http://127.0.0.1:4784" : "https://vercel-schedules.com"}/v1/schedules`,
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: "review-prs-daily",
        namespace: "eve-namespace",
        payload: {
          eve: { application: "dynamic-schedules", collection: "collection", version: 1 },
          payload: "Review PRs",
        },
        target: { type: "queue", topic: expect.stringMatching(/^__eve_schedule_/u) },
      });
      expect(init?.headers).toBeInstanceOf(Headers);
      expect(init?.signal).toBe(context.abortSignal);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${local ? "local-token" : oidcToken}`,
      );
      expect(new Headers(init?.headers).get("x-vss-framework")).toBe("eve");
    },
  );

  it("patches only supplied configuration, wraps replacement payloads, and clears omitted timing options", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(schedule()));
    const provider = vercelScheduleProvider({ fetch: fetchImpl });
    await provider.update(context, "review-prs-daily", { payload: { task: "Updated" } });
    await provider.update(context, "review-prs-daily", {
      expression: { type: "cron", cron: "0 9 * * *" },
    });
    const [url, payloadRequest] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://vercel-schedules.com/v1/schedules/review-prs-daily?namespace=eve-namespace",
    );
    expect(payloadRequest?.method).toBe("PATCH");
    expect(JSON.parse(String(payloadRequest?.body))).toEqual({
      payload: {
        eve: { application: "dynamic-schedules", collection: "collection", version: 1 },
        payload: { task: "Updated" },
      },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toEqual({
      expression: { type: "cron", cron: "0 9 * * *" },
      timezone: "UTC",
      jitter: null,
    });
  });

  it("omits a blank first-page cursor", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [], cursor: null }));
    const provider = vercelScheduleProvider({ fetch: fetchImpl });

    await provider.list(context, { cursor: "", limit: 20 });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://vercel-schedules.com/v1/schedules?namespace=eve-namespace&limit=20",
    );
  });

  it("lists hosted preview schedules with OIDC even when local API markers are present", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_preview");
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
    vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", "1");
    vi.stubEnv("VERCEL_SCHEDULE_BASE_URL", undefined);
    vi.stubEnv("VERCEL_SCHEDULE_TOKEN", "local-token");
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [schedule()], cursor: null }),
    );
    const provider = vercelScheduleProvider({ fetch: fetchImpl });

    await expect(provider.list(context, {})).resolves.toMatchObject({
      data: [{ name: "review-prs-daily", scheduleId: "sch_1" }],
      cursor: null,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://vercel-schedules.com/v1/schedules?namespace=eve-namespace");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${oidcToken}`);
  });

  it("rejects unsupported hosts before calling the API", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", undefined);
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = vercelScheduleProvider({ fetch: fetchImpl });

    await expect(provider.list(context, {})).rejects.toThrow(
      "requires a Vercel deployment or eve dev",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing local authentication without falling back", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", undefined);
    vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", "1");
    vi.stubEnv("VERCEL_SCHEDULE_BASE_URL", "http://127.0.0.1:4784");
    vi.stubEnv("VERCEL_SCHEDULE_TOKEN", undefined);
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = vercelScheduleProvider({ fetch: fetchImpl });

    await expect(provider.list(context, {})).rejects.toThrow("VERCEL_SCHEDULE_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["on a deployment", { VERCEL: "1" }],
    ["under standalone eve dev", { EVE_DEV: "1", NODE_ENV: "development" }],
  ])("rejects cron expressions Vercel Schedules can't run %s", (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", undefined);
    const validate = (cron: string) =>
      vercelScheduleProvider().validateExpression?.({ type: "cron", cron });

    for (const cron of ["0 9 * * 1-5", "*/15 0-6,22 1 1,7 *", "5/10 * * * 0,7"])
      expect(() => validate(cron)).not.toThrow();
    expect(() => validate("0 9 * * MON")).toThrow(/accepts no names.*0 is Sunday/u);
    expect(() => validate("0 9 * JAN *")).toThrow(/accepts no names/u);
    expect(() => validate("0 24 * * *")).toThrow('the hour field "24" is outside 0-23');
    expect(() => validate("0 9 0 * *")).toThrow('the day-of-month field "0" is outside 1-31');
    expect(() => validate("0 9 * * 1-")).toThrow('the day-of-week field "1-" is malformed');
    expect(() =>
      vercelScheduleProvider().validateExpression?.({ type: "single", at: "2026-10-01T12:00" }),
    ).not.toThrow();
  });

  it("uses the shared in-memory provider under standalone eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", undefined);
    const provider = vercelScheduleProvider();
    expect(provider.kind).toBe("in-memory");

    await provider.create(context, {
      expression: { type: "single", at: "2026-10-01T12:00:00", timezone: "UTC" },
      payload: "Review PRs",
      name: "review-prs",
    });
    await expect(
      provider.get({ ...context, operationId: "get" }, "review-prs"),
    ).resolves.toMatchObject({ name: "review-prs" });
  });
});
