import { afterEach, describe, expect, it, vi } from "vitest";

const getVercelOidcToken = vi.hoisted(() => vi.fn(async () => "oidc-token"));
vi.mock("#compiled/@vercel/oidc/index.js", () => ({ getVercelOidcToken }));

import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import type { ScheduleProviderContext } from "#public/schedules/collection.js";

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
  getVercelOidcToken.mockClear();
});

describe("vercelScheduleProvider", () => {
  it("creates a queue-target schedule with an eve dispatch envelope", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(schedule()));
    const provider = vercelScheduleProvider({ fetch: fetchImpl });

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
    expect(String(url)).toBe("https://vss-server.vercel.sh/v1/schedules");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "review-prs-daily",
      namespace: "eve-namespace",
      payload: {
        eve: { application: "dynamic-schedules", collection: "collection", version: 1 },
        input: { message: "Review PRs" },
      },
      target: { type: "queue", topic: expect.stringMatching(/^__eve_schedule_/u) },
    });
  });

  it("omits a blank first-page cursor", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [], cursor: null }));
    const provider = vercelScheduleProvider({
      fetch: fetchImpl,
      developmentBearerToken: "personal-token",
      developmentProjectId: "prj_123",
    });

    await provider.list(context, { cursor: "", limit: 20 });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://vss-server.vercel.sh/v1/schedules?namespace=eve-namespace&limit=20&projectId=prj_123",
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

  it("can explicitly use the Vercel control plane under eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [], cursor: null }));
    const provider = vercelScheduleProvider({
      fetch: fetchImpl,
      developmentBearerToken: "personal-token",
      developmentProjectId: "prj_123",
    });

    expect(provider.kind).toBe("vercel");
    await provider.list(context, {});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses the shared in-memory provider under eve dev by default", async () => {
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
