const [packageName, shape, traceFlagsText, audience = "public"] = process.argv.slice(2);
if (!packageName || !shape || traceFlagsText === undefined) {
  throw new Error(
    "Usage: historical-session-instrumentation-producer <package> <agent|marker|seed> <traceFlags> [audience]",
  );
}

const traceFlags = Number(traceFlagsText);
const traceId = "2".repeat(32);
const spanId = "1".repeat(16);
const sessionId = "legacy-session";
const packageEntry = import.meta.resolve(packageName);
const [container, keys, serialization] = await Promise.all([
  import(new URL("./context/container.js", packageEntry).href),
  import(new URL("./context/keys.js", packageEntry).href),
  import(new URL("./context/serialize.js", packageEntry).href),
]);
const ctx = new container.ContextContainer();
ctx.set(keys.ChannelInstrumentationKey, {
  channelType: "http",
  kind: "channel:http",
  metadata: { audience },
});

if (shape === "marker") {
  ctx.set(keys.OtelTraceEnabledKey, false);
} else if (shape === "seed") {
  ctx.set(keys.OtelTraceEnabledKey, true);
  ctx.set(keys.SessionTraceSeedKey, { spanId, traceFlags, traceId });
} else if (shape === "agent") {
  const storeModule = await import(
    new URL("./tracing/agent-trace-context-store.js", packageEntry).href
  );
  container.contextStorage.run(ctx, () => {
    new storeModule.ContextAgentTraceStateStore().setSession(sessionId, {
      agentName: "weather",
      channelAudience: audience,
      channelKind: "http",
      context: { isRemote: false, spanId, traceFlags, traceId },
      rootSessionId: sessionId,
      turnsInWindow: 7,
      window: 0,
    });
  });
} else {
  throw new Error(`Unknown historical session instrumentation shape "${shape}"`);
}

process.stdout.write(JSON.stringify(serialization.serializeContext(ctx)));
