import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

export interface StatefulMcpRequest {
  readonly method: string;
  readonly sessionId: string | null;
  readonly status: number;
}

export interface StatefulMcpServer {
  readonly fetch: typeof fetch;
  readonly requests: readonly StatefulMcpRequest[];
  readonly liveSessions: ReadonlySet<string>;
  waitForRequest(match: (request: StatefulMcpRequest) => boolean): Promise<StatefulMcpRequest>;
}

export function createStatefulMcpServer(
  registerTools?: (server: McpServer) => void,
): StatefulMcpServer {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const liveSessions = new Set<string>();
  const requests: StatefulMcpRequest[] = [];
  const waiters: {
    match: (request: StatefulMcpRequest) => boolean;
    resolve: (request: StatefulMcpRequest) => void;
  }[] = [];

  function record(request: Request, response: Response): Response {
    const entry = {
      method: request.method,
      sessionId: request.headers.get("mcp-session-id"),
      status: response.status,
    };
    requests.push(entry);
    for (const waiter of waiters.filter((candidate) => candidate.match(entry))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(entry);
    }
    return response;
  }

  async function newSession(request: Request): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
        liveSessions.add(sessionId);
      },
      onsessionclosed: (sessionId) => {
        transports.delete(sessionId);
        liveSessions.delete(sessionId);
      },
    });
    const server = new McpServer({ name: "stateful-fixture", version: "1.0.0" });
    server.registerTool("ping", { description: "Replies pong." }, () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    registerTools?.(server);
    await server.connect(transport);
    return await transport.handleRequest(request);
  }

  async function handle(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId === null) {
      const body: unknown = request.method === "POST" ? await request.clone().json() : undefined;
      if (typeof body === "object" && body !== null && "method" in body) {
        if (body.method === "initialize") return await newSession(request);
      }
      return Response.json({ error: "No valid session ID provided" }, { status: 400 });
    }
    const transport = transports.get(sessionId);
    if (transport === undefined) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    return await transport.handleRequest(request);
  }

  return {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      return record(request, await handle(request));
    },
    liveSessions,
    requests,
    waitForRequest: (match) => {
      const answered = requests.find(match);
      if (answered !== undefined) return Promise.resolve(answered);
      return new Promise((resolve) => {
        waiters.push({ match, resolve });
      });
    },
  };
}
