import { afterEach, describe, expect, it, vi } from "vitest";

import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import type { ScheduleProviderContext } from "#public/schedules/collection.js";

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
  it("creates a queue-target schedule with an eve dispatch envelope using ambient OIDC", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(schedule()));
    const provider = vercelScheduleProvider({
      fetch: fetchImpl,
      baseUrl: "https://vercel-schedules.com",
    });

    const record = await provider.create(context, {
      expression: {
        type: "cron",
        cron: "0 12 * * *",
        timezone: "America/New_York",
        jitter: 5,
      },
      input: { message: "Review PRs" },
      name: "review-prs-daily",
    });

    expect(provider.kind).toBe("vercel");
    expect(record).toMatchObject({ name: "review-prs-daily", scheduleId: "sch_1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://vercel-schedules.com/v1/schedules");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "review-prs-daily",
      namespace: "eve-namespace",
      payload: {
        eve: { application: "dynamic-schedules", collection: "collection", version: 1 },
        input: { message: "Review PRs" },
      },
      target: { type: "queue", topic: expect.stringMatching(/^__eve_schedule_/u) },
    });
    expect(init?.headers).toBeInstanceOf(Headers);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${oidcToken}`);
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

  it("rejects preview deployments before calling the API", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = vercelScheduleProvider({ fetch: fetchImpl });

    await expect(provider.list(context, {})).rejects.toThrow("production deployments only");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the shared in-memory provider under eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const provider = vercelScheduleProvider();
    expect(provider.kind).toBe("in-memory");

    await provider.create(context, {
      expression: { type: "single", at: "2026-10-01T12:00:00", timezone: "UTC" },
      input: { message: "Review PRs" },
      name: "review-prs",
    });
    await expect(
      provider.get({ ...context, operationId: "get" }, "review-prs"),
    ).resolves.toMatchObject({ name: "review-prs" });
  });
});
