import { beforeEach, describe, expect, it, vi } from "vitest";

import { isHttpSessionOwner, recordHttpSessionOwner } from "#eve-channel/session-owner.js";

const records = vi.hoisted(() => new Map<string, unknown[]>());

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: (sessionId: string) => ({
    getReadable: ({ namespace }: { namespace: string }) => {
      const values = records.get(`${sessionId}:${namespace}`) ?? [];
      return Object.assign(
        new ReadableStream({
          start(controller) {
            for (const value of values) controller.enqueue(value);
            controller.close();
          },
        }),
        { getTailIndex: async () => values.length - 1 },
      );
    },
    getWritable: ({ namespace }: { namespace: string }) =>
      new WritableStream({
        write(value) {
          const key = `${sessionId}:${namespace}`;
          records.set(key, [...(records.get(key) ?? []), value]);
        },
      }),
  }),
}));

const alice = {
  attributes: {},
  authenticator: "app",
  issuer: "workspace-a",
  principalId: "alice",
  principalType: "user",
};

beforeEach(() => records.clear());

describe("HTTP session ownership", () => {
  it("permits only the recorded creator, including the issuer boundary", async () => {
    await recordHttpSessionOwner("alice-session", alice);

    await expect(isHttpSessionOwner("alice-session", alice)).resolves.toBe(true);
    await expect(
      isHttpSessionOwner("alice-session", { ...alice, principalId: "bob" }),
    ).resolves.toBe(false);
    await expect(
      isHttpSessionOwner("alice-session", { ...alice, issuer: "workspace-b" }),
    ).resolves.toBe(false);
    await expect(isHttpSessionOwner("another-session", alice)).resolves.toBe(false);
    expect(JSON.stringify([...records.values()])).not.toContain("alice");
  });

  it("keeps an explicit issuer distinct from an authenticator with the same name", async () => {
    await recordHttpSessionOwner("implicit-issuer-session", { ...alice, issuer: undefined });
    await expect(
      isHttpSessionOwner("implicit-issuer-session", { ...alice, issuer: "app" }),
    ).resolves.toBe(false);
  });

  it("does not replace or append to an existing ownership record on retries", async () => {
    await recordHttpSessionOwner("alice-session", alice);
    await recordHttpSessionOwner("alice-session", alice);
    await expect(
      recordHttpSessionOwner("alice-session", { ...alice, principalId: "bob" }),
    ).rejects.toThrow("different HTTP owner");

    expect([...records.values()][0]).toHaveLength(1);
    await expect(isHttpSessionOwner("alice-session", alice)).resolves.toBe(true);
  });

  it("snapshots identity independently of later caller changes", async () => {
    const caller = { ...alice };
    await recordHttpSessionOwner("alice-session", caller);
    caller.principalId = "bob";

    await expect(isHttpSessionOwner("alice-session", alice)).resolves.toBe(true);
    await expect(isHttpSessionOwner("alice-session", caller)).resolves.toBe(false);
  });

  it("does not create user ownership for deployment-wide transport principals", async () => {
    await recordHttpSessionOwner("service-session", { ...alice, principalType: "service" });
    expect(records.size).toBe(0);
  });
});
