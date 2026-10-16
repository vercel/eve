import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Applies exact upstream snippet replacements to `@ai-sdk/mcp/dist/index.js`.
 * The build fails when a snippet is missing, so a dependency bump cannot
 * silently drop the patch.
 */
function patchMcpSourcePlugin(name, replacements) {
  let patched = false;

  return {
    name: `eve-ai-sdk-mcp-${name}`,
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@ai-sdk/mcp/dist/index.js")) {
        return null;
      }
      let next = code;
      for (const [source, replacement] of replacements) {
        if (!next.includes(source)) {
          throw new Error(`@ai-sdk/mcp source for the ${name} patch changed.`);
        }
        next = next.replace(source, replacement);
      }
      patched = true;
      return { code: next, map: null };
    },
    buildEnd() {
      if (!patched) {
        throw new Error(`@ai-sdk/mcp ${name} patch was not applied.`);
      }
    },
  };
}

// Streamable HTTP always answers, so a slow `server/discover` is not a legacy
// signal: the MCP spec falls back there only on a 4xx. Upstream caps the probe
// at 1 s on every transport and then downgrades modern-only servers to
// `initialize`. Remove once @ai-sdk/mcp ships vercel/ai#22042.
const waitForHttpProtocolDiscovery = patchMcpSourcePlugin("wait-for-http-discovery", [
  [
    "timeout: DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT",
    "timeout: this.transport instanceof HttpMCPTransport ? void 0 : DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT",
  ],
]);

// A 2025-era session allows one standalone GET stream; MCP SDK servers answer
// a second with 409 and stateful gateways drop the session (#4379). Upstream
// marks the stream only once a GET's response arrives, so one connect sends up
// to three GETs, the first before `initialize` has created the session, and
// its reconnect timer opens another GET even when a stream is attached.
// `inboundSseConnection` becomes the one stream slot: taken synchronously when
// a GET starts, released when that GET fails or its stream ends, and every
// opener (start, protocol switch, 202, reconnect timer) goes through
// `startInboundSse`, which returns while the slot is taken. A protocol switch
// opens the stream only once a session exists; a fresh session's
// `notifications/initialized` 202 opens it otherwise. Remove once
// @ai-sdk/mcp gives `HttpMCPTransport` a single inbound stream.
const singleInboundSseStream = patchMcpSourcePlugin("single-inbound-sse-stream", [
  [
    "\t\tif (!this.inboundSseConnection) this.startInboundSse();\n\t}\n\tisModernProtocol() {",
    "\t\tif (this.sessionId) this.startInboundSse();\n\t}\n\tisModernProtocol() {",
  ],
  [
    "\t\tif (this.isModernProtocol()) return;\n\t\tthis.openInboundSse(triedAuth, resumeToken).catch((error) => {",
    `\t\tif (this.isModernProtocol() || this.inboundSseConnection) return;
\t\tconst pending = { close() {} };
\t\tthis.inboundSseConnection = pending;
\t\tthis.openInboundSse(triedAuth, resumeToken).finally(() => {
\t\t\tif (this.inboundSseConnection === pending) this.inboundSseConnection = void 0;
\t\t}).catch((error) => {`,
  ],
  [
    "\t\t\tthis.inboundReconnectAttempts = 0;\n\t\t\tprocessEvents().catch((error) => {",
    `\t\t\tthis.inboundReconnectAttempts = 0;
\t\t\tconst connection = this.inboundSseConnection;
\t\t\tprocessEvents().finally(() => {
\t\t\t\tif (this.inboundSseConnection === connection) this.inboundSseConnection = void 0;
\t\t\t}).catch((error) => {`,
  ],
]);

// Ending a 2025-era session is one DELETE, and nothing bounds it upstream:
// `close()` sends it with no signal, so a server that stops answering stalls
// every caller that awaits the close, and eve awaits it when a step ends. The
// DELETE now runs under a 5 s deadline of its own that is cleared once it
// settles. The deadline is best effort: an unreachable server keeps the
// session until it expires it. Remove once @ai-sdk/mcp bounds session
// termination.
const boundedSessionTermination = patchMcpSourcePlugin("bounded-session-termination", [
  [
    `\t\t\t\tawait this.fetchFn(this.url.href, {
\t\t\t\t\tmethod: "DELETE",
\t\t\t\t\theaders,
\t\t\t\t\tsignal: options?.signal,
\t\t\t\t\tredirect: this.redirectMode
\t\t\t\t}).catch(() => void 0);`,
    `\t\t\t\tconst deadline = new AbortController();
\t\t\t\tconst timer = setTimeout(() => deadline.abort(), 5e3);
\t\t\t\tawait this.fetchFn(this.url.href, {
\t\t\t\t\tmethod: "DELETE",
\t\t\t\t\theaders,
\t\t\t\t\tsignal: options?.signal ?? deadline.signal,
\t\t\t\t\tredirect: this.redirectMode
\t\t\t\t}).catch(() => void 0).finally(() => clearTimeout(timer));`,
  ],
]);

export default {
  packageName: "@ai-sdk/mcp",
  compiledPath: "@ai-sdk/mcp",
  chunkGroup: "workflow",
  plugins: [waitForHttpProtocolDiscovery, singleInboundSseStream, boundedSessionTermination],
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "@ai-sdk/provider-utils": {
        kind: "vendored",
        compiledPath: "@ai-sdk/provider-utils",
      },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
