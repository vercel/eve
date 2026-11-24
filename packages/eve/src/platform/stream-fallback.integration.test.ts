import { expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import { installFallbackWorkflowEngine } from "#execution/workflow-host/host.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { alice, probe, recorded } from "#internal/testing/session-host/probe.js";
import { createStoreEngine } from "#internal/testing/session-host/store-engine.js";
import type { MemorySessionStore } from "#internal/testing/session-host/memory-session-store.js";
import { definePlatform } from "#platform/declaration.js";
import { storeDurable } from "#platform/engine.js";
import { builtInHosts, createProcessApp, installProcessApp, type App } from "#runtime/app.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { bootProcess } from "#runtime/lifecycle.js";
import { endLifetime } from "#runtime/lifetime.js";
import { start } from "#runtime/start.js";

async function eventTypesOf(runtime: Runtime, sessionId: string): Promise<string[]> {
  return (await recorded(runtime, sessionId)).map((event) => event.type);
}

async function linesOf(runtime: Runtime, sessionId: string): Promise<unknown[]> {
  const records: unknown[] = [];
  for await (const record of await runtime.getLineStream(sessionId, { follow: false }))
    records.push(record);
  return records;
}

async function expectStreamFromDurable(
  app: App,
  sessionId: string,
  expected: { readonly lines: unknown[]; readonly tail: number; readonly eventTypes: string[] },
): Promise<void> {
  const runtime = sessionRuntime(app.durable, app.hosts, {
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  expect(await runtime.getStreamTailIndex(sessionId)).toBe(expected.tail);
  expect(await linesOf(runtime, sessionId)).toEqual(expected.lines);
  expect(await eventTypesOf(runtime, sessionId)).toEqual(expected.eventTypes);
  const following = (await runtime.getEventStream(sessionId)).getReader();
  expect((await following.read()).value?.type).toBe(expected.eventTypes[0]);
  await following.cancel();
}

async function servedFromAnotherApp(
  name: string,
  serve: (input: {
    readonly sessionId: string;
    readonly store: MemorySessionStore;
    readonly expected: Parameters<typeof expectStreamFromDurable>[2];
  }) => Promise<void>,
): Promise<void> {
  const agent = await probe({ name, respond: () => textStreamResult("Noted.") });
  await agent.test.run(async () => {
    const config = { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() };
    const first = createStoreEngine(config, { callbackBaseUrl: "http://first.in-process" });
    const { sessionId } = await (
      await alice(first.runtime, `${name}:alice`).send("Alice asks.", { auth: null })
    ).result();
    await first.idle();
    const expected = {
      lines: await linesOf(first.runtime, sessionId),
      tail: await first.runtime.getStreamTailIndex(sessionId),
      eventTypes: await eventTypesOf(first.runtime, sessionId),
    };
    expect(expected.lines.length).toBeGreaterThan(1);
    await first.dispose();
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", undefined);
    const uninstall = installProcessApp(createProcessApp());
    try {
      await serve({ sessionId, store: first.store, expected });
    } finally {
      uninstall();
      vi.unstubAllEnvs();
    }
  });
}

async function startStoreApp(name: string, store: MemorySessionStore): Promise<App> {
  const platform = definePlatform({
    deployment: () => ({
      environment: () => "production",
      deploymentId: () => "dpl_bob",
      productionHost: () => undefined,
      publicHost: () => undefined,
      scope: () => undefined,
    }),
    durable: () => ({ start: () => storeDurable({ store, wake: async () => {} }).durable }),
  });
  await bootProcess({ agentName: name, platform }, "artifacts");
  return await start({
    defaultDurable: () => {
      throw new Error("The app runs the platform's engine.");
    },
  });
}

it("serves a session stream from the engine's Durable in an app that holds no reader for it", async () => {
  await servedFromAnotherApp("stream-fallback", async ({ sessionId, store, expected }) => {
    const app = await startStoreApp("stream-fallback", store);
    try {
      expect(app.hosts.streams.bySession.has(sessionId)).toBe(false);
      await expectStreamFromDurable(app, sessionId, expected);
    } finally {
      await endLifetime(app.lifetime);
    }
    expect(app.hosts.streams.app).toBeUndefined();
  });
});

it("keeps reading through the engine's Durable when the Workflow fallback engine loads before and after start", async () => {
  await servedFromAnotherApp("stream-fallback-order", async ({ sessionId, store, expected }) => {
    vi.resetModules();
    await import("#internal/workflow/builtins.js");
    expect(builtInHosts().engine?.name).toBe("workflow");

    const app = await startStoreApp("stream-fallback-order", store);
    try {
      await expectStreamFromDurable(app, sessionId, expected);
      installFallbackWorkflowEngine(builtInHosts());
      await expectStreamFromDurable(app, sessionId, expected);
    } finally {
      await endLifetime(app.lifetime);
    }
  });
});
