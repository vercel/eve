import { defineDynamic, defineMcpClientConnection } from "eve/connections";

const SUPPORTED_TRANSPORTS = new Set(["streamable-http", "sse"]);

interface TaskMcpServer {
  readonly name: string;
  readonly transport: "streamable-http" | "sse";
  readonly url: string;
}

function parseTaskMcpServer(entry: unknown, index: number): TaskMcpServer {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`EVE_BENCH_MCP_SERVERS[${index}] must be an object`);
  }
  const { name, transport, url } = entry as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`EVE_BENCH_MCP_SERVERS[${index}].name must be a non-empty string`);
  }
  if (typeof transport !== "string" || !SUPPORTED_TRANSPORTS.has(transport)) {
    throw new Error(
      `EVE_BENCH_MCP_SERVERS[${index}] (${name}) has unsupported transport: ${String(transport)}`,
    );
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`EVE_BENCH_MCP_SERVERS[${index}] (${name}).url must be a non-empty string`);
  }
  return { name, transport: transport as TaskMcpServer["transport"], url };
}

function taskMcpServers(): readonly TaskMcpServer[] {
  const value = process.env.EVE_BENCH_MCP_SERVERS;
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("EVE_BENCH_MCP_SERVERS must be a JSON array");
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const server = parseTaskMcpServer(entry, index);
    if (seen.has(server.name)) {
      throw new Error(`EVE_BENCH_MCP_SERVERS contains duplicate server name: ${server.name}`);
    }
    seen.add(server.name);
    return server;
  });
}

export default defineDynamic(() =>
  Object.fromEntries(
    taskMcpServers().map((server) => [
      server.name,
      defineMcpClientConnection({
        url: server.url,
        description: `Task-scoped MCP tools from ${server.name}.`,
      }),
    ]),
  ),
);
