import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

const issues = readFileSync(new URL("./issues.json", import.meta.url), "utf8");

async function handle(request) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: "issues", version: "1.0.0" });
  server.registerTool("list_issues", { description: "List the issues of the repository as JSON." }, () => ({
    content: [{ type: "text", text: issues }],
  }));
  await server.connect(transport);
  return await transport.handleRequest(request);
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://127.0.0.1:8787${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787, "127.0.0.1", () => console.log("issues MCP server on :8787"));
