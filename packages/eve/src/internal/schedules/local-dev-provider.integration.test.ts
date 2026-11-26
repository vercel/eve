import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  localDevScheduleProvider,
  resolveLocalDevScheduleDatabasePath,
} from "#internal/schedules/local-dev-provider.js";
import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import { sharedLocalDevScheduleStore } from "#internal/schedules/local-dev-store.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";

const provider = localDevScheduleProvider({ validateExpression: () => {} });
let appRoot: string;

const context = (
  operationId: string,
  target: ScheduleProviderContext["target"] = { key: "app" },
): ScheduleProviderContext => ({
  abortSignal: new AbortController().signal,
  collection: "tasks",
  namespace: "namespace",
  operationId,
  target,
});

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), "eve-local-dev-provider-"));
  vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, appRoot);
});

afterEach(() => {
  sharedLocalDevScheduleStore(resolveLocalDevScheduleDatabasePath(appRoot)).close();
  vi.unstubAllEnvs();
  rmSync(appRoot, { recursive: true, force: true });
});

describe("localDevScheduleProvider", () => {
  it("stores a one-time schedule due soon as active, reading `at` in UTC regardless of the process timezone", async () => {
    const at = new Date(Date.now() + 60_000 + 59_000).toISOString().slice(0, 16);
    const created = await provider.create(context("create"), {
      name: "once",
      expression: { type: "single", at, timezone: "UTC" },
      payload: { note: "x" },
    });
    expect(created).toMatchObject({ name: "once", state: "active" });
    expect(created.scheduleId).toMatch(/^local_/u);
    await expect(provider.get(context("get"), "once")).resolves.toEqual(created);
  });

  it("completes a one-time schedule whose time has passed", async () => {
    const created = await provider.create(context("create"), {
      name: "past",
      expression: { type: "single", at: "2020-01-01T00:00", timezone: "UTC" },
      payload: {},
    });
    expect(created.state).toBe("completed");
    await expect(provider.invoke(context("invoke"), "past")).rejects.toThrow(
      /Completed schedule "past" cannot be invoked/u,
    );
  });

  it("keeps schedules in the app's database across store handles", async () => {
    await provider.create(context("create"), {
      name: "daily",
      expression: { type: "cron", cron: "0 9 * * *" },
      payload: {},
    });
    sharedLocalDevScheduleStore(resolveLocalDevScheduleDatabasePath(appRoot)).close();
    await expect(provider.get(context("get"), "daily")).resolves.toMatchObject({ name: "daily" });
  });

  it("replays create, delete and invoke for a repeated operation id", async () => {
    const input = {
      name: "daily",
      expression: { type: "cron" as const, cron: "0 9 * * *" },
      payload: {},
    };
    const first = await provider.create(context("create"), input);
    await expect(provider.create(context("create"), input)).resolves.toEqual(first);
    await expect(provider.create(context("create-2"), input)).rejects.toThrow(/already exists/u);
    const deliver = vi.fn(async (_delivery: unknown) => {});
    await provider.invoke(context("invoke", { key: "app", deliver }), "daily");
    await provider.invoke(context("invoke", { key: "app", deliver }), "daily");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]![0]).toEqual(deliver.mock.calls[1]![0]);
    await expect(provider.delete(context("delete"), "daily")).resolves.toBe(true);
    await expect(provider.delete(context("delete"), "daily")).resolves.toBe(true);
    await expect(provider.delete(context("delete-2"), "daily")).resolves.toBe(false);
  });

  it("disables, enables and updates, moving the next fire time with the state", async () => {
    const store = () => sharedLocalDevScheduleStore(resolveLocalDevScheduleDatabasePath(appRoot));
    await provider.create(context("create"), {
      name: "daily",
      expression: { type: "cron", cron: "0 9 * * *" },
      payload: { v: 1 },
    });
    expect(store().earliestFireAtMs()).not.toBeNull();
    await expect(provider.disable(context("disable"), "daily")).resolves.toMatchObject({
      state: "inactive",
    });
    expect(store().earliestFireAtMs()).toBeNull();
    await expect(provider.enable(context("enable"), "daily")).resolves.toMatchObject({
      state: "active",
    });
    expect(store().earliestFireAtMs()).not.toBeNull();
    await provider.update(context("update"), "daily", { payload: { v: 2 } });
    expect(store().get("tasks", "namespace", "daily")?.payload).toEqual({ v: 2 });
  });

  it("lists in name order with a cursor", async () => {
    for (const name of ["c", "a", "b"]) {
      await provider.create(context(`create-${name}`), {
        name,
        expression: { type: "cron", cron: "0 9 * * *" },
        payload: {},
      });
    }
    const first = await provider.list(context("list-1"), { limit: 2 });
    expect(first.data.map(({ name }) => name)).toEqual(["a", "b"]);
    const second = await provider.list(context("list-2"), { limit: 2, cursor: first.cursor! });
    expect(second).toMatchObject({ cursor: null, data: [{ name: "c" }] });
  });

  it("fails clearly when the dev worker's app root is missing", async () => {
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, "");
    await expect(provider.get(context("get"), "x")).rejects.toThrow(
      DEVELOPMENT_WORKER_APP_ROOT_ENV,
    );
  });

  it("is what vercelScheduleProvider returns under standalone eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_SCHEDULE_DEV_API_VERSION", undefined);
    const dev = vercelScheduleProvider();
    expect(dev.kind).toBe("local-dev");
    await dev.create(context("create"), {
      name: "review-prs",
      expression: { type: "single", at: "2099-10-01T12:00", timezone: "UTC" },
      payload: "Review PRs",
    });
    await expect(dev.get(context("get"), "review-prs")).resolves.toMatchObject({
      state: "active",
    });
  });
});
