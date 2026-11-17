import { createDeclarationCopier } from "../_shared.mjs";

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

const waitForHttpProtocolDiscovery = patchMcpSourcePlugin("wait-for-http-discovery", [
  [
    "timeout: DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT",
    "timeout: this.transport instanceof HttpMCPTransport ? void 0 : DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT",
  ],
]);

const supportedProtocolVersionFallback = patchMcpSourcePlugin(
  "supported-protocol-version-fallback",
  [
    [
      "\t\t\tif (MCPClientError.isInstance(error) && error.code != null && MODERN_PROTOCOL_ERROR_CODES.includes(error.code)) throw error;",
      `\t\t\tif (MCPClientError.isInstance(error) && error.code != null && MODERN_PROTOCOL_ERROR_CODES.includes(error.code)) {
\t\t\t\tif (error.code !== -32022 || !Array.isArray(error.data?.supported)) throw error;
\t\t\t\tconst supportedVersions = error.data.supported;
\t\t\t\tconst protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find(
\t\t\t\t\t(version) =>
\t\t\t\t\t\tversion !== LATEST_PROTOCOL_VERSION && supportedVersions.includes(version),
\t\t\t\t);
\t\t\t\tif (protocolVersion === void 0) throw error;
\t\t\t\tthis.protocolVersion = protocolVersion;
\t\t\t\treturn false;
\t\t\t}`,
    ],
    [
      '\t\t\tthis.protocolEra = "legacy";\n\t\t\tthis.protocolVersion = LATEST_LEGACY_PROTOCOL_VERSION;\n\t\t\tthis.setTransportProtocolVersion(this.protocolVersion);',
      `\t\t\tthis.protocolEra = "legacy";
\t\t\tif (this.protocolVersion === LATEST_PROTOCOL_VERSION) {
\t\t\t\tthis.protocolVersion = LATEST_LEGACY_PROTOCOL_VERSION;
\t\t\t}
\t\t\tthis.setTransportProtocolVersion(this.protocolVersion);`,
    ],
    [
      'method: "initialize",\n\t\t\t\t\tparams: {\n\t\t\t\t\t\tprotocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,\n\t\t\t\t\t\tcapabilities: this.clientCapabilities,',
      `method: "initialize",
\t\t\t\t\tparams: {
\t\t\t\t\t\tprotocolVersion: this.protocolVersion,
\t\t\t\t\t\tcapabilities: this.clientCapabilities,`,
    ],
  ],
);

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
  plugins: [
    waitForHttpProtocolDiscovery,
    supportedProtocolVersionFallback,
    singleInboundSseStream,
    boundedSessionTermination,
  ],
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
