import { createDeclarationCopier } from "../_shared.mjs";

const DISCOVERY_TIMEOUT_SOURCE = "timeout: DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT";
const HTTP_DISCOVERY_TIMEOUT_SOURCE =
  "timeout: this.transport instanceof HttpMCPTransport ? void 0 : DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT";

// Streamable HTTP always answers, so a slow `server/discover` is not a legacy
// signal: the MCP spec falls back there only on a 4xx. Upstream caps the probe
// at 1 s on every transport and then downgrades modern-only servers to
// `initialize`. Remove once @ai-sdk/mcp ships vercel/ai#22042; the contract
// check below fails the build when that line changes.
function waitForHttpProtocolDiscoveryPlugin() {
  let patched = false;

  return {
    name: "eve-ai-sdk-mcp-wait-for-http-discovery",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@ai-sdk/mcp/dist/index.js")) {
        return null;
      }
      if (!code.includes(DISCOVERY_TIMEOUT_SOURCE)) {
        throw new Error("@ai-sdk/mcp's server/discover timeout contract changed.");
      }
      patched = true;
      return {
        code: code.replace(DISCOVERY_TIMEOUT_SOURCE, HTTP_DISCOVERY_TIMEOUT_SOURCE),
        map: null,
      };
    },
    buildEnd() {
      if (!patched) {
        throw new Error("@ai-sdk/mcp's server/discover timeout was not patched.");
      }
    },
  };
}

export default {
  packageName: "@ai-sdk/mcp",
  compiledPath: "@ai-sdk/mcp",
  chunkGroup: "workflow",
  plugins: [waitForHttpProtocolDiscoveryPlugin()],
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
