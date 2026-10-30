import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { createSessionValueStore } from "#execution/session-value-store.js";
import { decodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

const VALUE = { report: "x".repeat(4096) };

function contextWith(access: unknown): ContextContainer {
  const ctx = new ContextContainer();
  if (access !== undefined) ctx.set(SandboxKey, access as never);
  return ctx;
}

describe("createSessionValueStore", () => {
  it("writes the value to the sandbox and returns a resolvable reference", async () => {
    const sandbox = mockSandbox();
    const stage = createSessionValueStore(contextWith(sandbox.access));

    const reference = await stage(VALUE, 0);

    expect(reference.withheld).toBeUndefined();
    expect(reference.mediaType).toBe("application/json");
    const ref = decodeSandboxRef(reference.ref as string);
    expect(ref.mediaType).toBe("application/json");
    // Addressed where a person looking inside the sandbox would expect it, and readable back
    // through the same path every other out-of-line payload uses.
    expect(ref.path).toContain("/.eve/values/");
    expect(sandbox.files.get(ref.path)).toBe(JSON.stringify(VALUE));
    expect(ref.size).toBe(JSON.stringify(VALUE).length);
  });

  it("writes one file for a value staged twice", async () => {
    // A retried step republishes its commit; content addressing keeps that from leaving an
    // orphan behind.
    const sandbox = mockSandbox();
    const stage = createSessionValueStore(contextWith(sandbox.access));

    const first = await stage(VALUE, 0);
    const second = await stage(VALUE, 0);

    expect(second.ref).toBe(first.ref);
    expect(sandbox.writes).toHaveLength(2);
    expect(sandbox.files.size).toBe(1);
  });

  it("opens the sandbox once across several values", async () => {
    const sandbox = mockSandbox();
    let opens = 0;
    const stage = createSessionValueStore(
      contextWith({
        ...sandbox.access,
        open: async () => {
          opens++;
          return sandbox.session;
        },
      }),
    );

    await stage({ a: 1 }, 0);
    await stage({ b: 2 }, 0);

    expect(opens).toBe(1);
  });

  it("withholds the value when no sandbox is bound", async () => {
    const stage = createSessionValueStore(contextWith(undefined));

    expect(await stage(VALUE, 0)).toEqual({
      mediaType: "application/json",
      withheld: true,
    });
  });

  it("withholds the value when the sandbox cannot be opened", async () => {
    const sandbox = mockSandbox();
    const stage = createSessionValueStore(
      contextWith({ ...sandbox.access, open: async () => null }),
    );

    expect((await stage(VALUE, 0)).withheld).toBe(true);
  });

  it("withholds the value when the write fails", async () => {
    // The commit's facts have already happened. Refusing to publish them because their payload
    // could not be stored would lose the facts as well as the payload.
    const sandbox = mockSandbox();
    const stage = createSessionValueStore(
      contextWith({
        ...sandbox.access,
        open: async () => ({
          ...sandbox.session,
          writeBinaryFile: async () => {
            throw new Error("sandbox is past its timeout");
          },
        }),
      }),
    );

    expect((await stage(VALUE, 0)).withheld).toBe(true);
  });
});
