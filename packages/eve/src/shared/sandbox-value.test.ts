import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import {
  defineSandboxAdapter,
  isSandbox,
  restoreSandbox,
  serializeSandbox,
  shutdownSandbox,
  withSandboxProviderContext,
} from "#shared/sandbox-value.js";

interface TestReference extends JsonObject {
  readonly id: string;
}

describe("defineSandboxAdapter", () => {
  it("serializes provider state and restores the handle lazily", async () => {
    const raw = mockSandbox({ id: "sandbox_1" });
    const restore = vi.fn((_reference: TestReference, _context: unknown) => raw);
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-sandbox-value-restore",
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore(reference, context) {
        return restore(reference, context);
      },
      session(sandbox) {
        return sandbox.session;
      },
    });
    const transient = adapt(raw);

    expect(isSandbox(transient)).toBe(true);
    await transient.run({ command: "echo transient" });
    await expect(serializeSandbox(transient)).rejects.toThrow(/Cannot persist transient sandbox/);
    expect(raw.commandLog).toEqual(["echo transient"]);

    const sandbox = await withTestContext(
      async () =>
        await withSandboxProviderContext(
          {
            appRoot: "/app",
            resourceId: "eve-resource-1",
            signal: new AbortController().signal,
          },
          async () => await adapt.create(() => raw),
        ),
    );
    const serialized = await serializeSandbox(sandbox);
    expect(serialized).toMatchObject({
      adapterId: "eve/test-sandbox-value-restore",
      id: "sandbox_1",
      reference: { id: "sandbox_1" },
      resourceId: "eve-resource-1",
    });

    const signal = new AbortController().signal;
    const restored = restoreSandbox(serialized, {
      appRoot: "/app",
      signal,
      tags: { agent: "reviewer" },
    });
    expect(restored.id).toBe("sandbox_1");
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();

    await restored.run({ command: "echo restored" });
    expect(restore).toHaveBeenCalledWith(
      { id: "sandbox_1" },
      {
        appRoot: "/app",
        resourceId: "eve-resource-1",
        signal,
        tags: { agent: "reviewer" },
      },
    );
    expect(raw.commandLog).toEqual(["echo transient", "echo restored"]);
  });

  it("supplies stable framework creation context without app-authored plumbing", async () => {
    const raw = mockSandbox({ id: "provider-handle" });
    const create = vi.fn(() => raw);
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-sandbox-provider-context",
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore() {
        return raw;
      },
      session(sandbox) {
        return sandbox.session;
      },
    });
    const signal = new AbortController().signal;

    const sandbox = await withTestContext(
      async () =>
        await withSandboxProviderContext(
          {
            appRoot: "/app",
            resourceId: "eve-resource-1",
            signal,
            tags: { agent: "researcher" },
          },
          async () => await adapt.create(create),
        ),
    );

    expect(create).toHaveBeenCalledWith({
      appRoot: "/app",
      resourceId: "eve-resource-1",
      signal,
      tags: { agent: "researcher" },
    });
    await expect(serializeSandbox(sandbox)).resolves.toMatchObject({
      id: "provider-handle",
      resourceId: "eve-resource-1",
    });
    await expect(adapt.create(create)).rejects.toThrow(/requires an active sandbox definition/);
  });

  it("rejects non-JSON provider references at the durability boundary", async () => {
    const raw = mockSandbox();
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-sandbox-value-lazy",
      reference() {
        return { invalid: new Date() } as never;
      },
      restore() {
        return raw;
      },
      session(sandbox) {
        return sandbox.session;
      },
    });

    const sandbox = await withTestContext(
      async () =>
        await withSandboxProviderContext(
          {
            appRoot: "/app",
            resourceId: "eve-resource-invalid-reference",
            signal: new AbortController().signal,
          },
          async () => await adapt.create(() => raw),
        ),
    );

    await expect(serializeSandbox(sandbox)).rejects.toThrow(/Expected a JSON-serializable value/);
  });

  it("retries a lazy restore after a transient reconnect failure", async () => {
    const raw = mockSandbox({ id: "sandbox_1" });
    let failures = 1;
    const restore = vi.fn((_reference: TestReference) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("provider unreachable");
      }
      return raw;
    });
    defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-sandbox-value-restore-retry",
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore(reference) {
        return restore(reference);
      },
      session(sandbox) {
        return sandbox.session;
      },
    });
    const restored = restoreSandbox(
      {
        adapterId: "eve/test-sandbox-value-restore-retry",
        id: "sandbox_1",
        reference: { id: "sandbox_1" },
        resourceId: "eve-resource-1",
      },
      { appRoot: "/app" },
    );

    await expect(restored.run({ command: "echo one" })).rejects.toThrow("provider unreachable");
    await expect(restored.run({ command: "echo two" })).resolves.toMatchObject({ exitCode: 0 });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(raw.commandLog).toEqual(["echo two"]);
  });

  it("runs provider shutdown at most once for one durable value", async () => {
    const raw = mockSandbox();
    const shutdown = vi.fn();
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-sandbox-value-shutdown",
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore() {
        return raw;
      },
      session(sandbox) {
        return sandbox.session;
      },
      shutdown,
    });
    const sandbox = adapt(raw);

    await Promise.all([shutdownSandbox(sandbox), shutdownSandbox(sandbox)]);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("keeps each adapter attached to its own provider implementation", async () => {
    const firstRaw = mockSandbox({ id: "first" });
    const secondRaw = mockSandbox({ id: "second" });
    const first = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-shared-protocol",
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore() {
        return firstRaw;
      },
      session(sandbox) {
        return sandbox.session;
      },
    });
    defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      type: "eve/test-shared-protocol",
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore() {
        return secondRaw;
      },
      session(sandbox) {
        return sandbox.session;
      },
    });

    const sandbox = first(firstRaw);
    await sandbox.run({ command: "echo first" });

    expect(firstRaw.commandLog).toEqual(["echo first"]);
    expect(secondRaw.commandLog).toEqual([]);
  });
});

async function withTestContext<T>(callback: () => Promise<T>): Promise<T> {
  return await contextStorage.run(new ContextContainer(), callback);
}
