import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

/** The HTTP method and, for a POST, the JSON-RPC method. */
export interface StatefulMcpRequestShape {
  readonly method: string;
  readonly rpcMethod: string | undefined;
}

export interface StatefulMcpRequest extends StatefulMcpRequestShape {
  readonly sessionId: string | null;
  readonly status: number;
}

export interface HeldRequest {
  /** Resolves once the held request has arrived. */
  readonly reached: Promise<void>;
  /** Lets the held request through to the server. */
  release(): void;
}

export interface StatefulMcpServer {
  /** Serves MCP Streamable HTTP in-process; pass it as the client's `fetch`. */
  readonly fetch: typeof fetch;
  /** Every request the server answered, in order. */
  readonly requests: readonly StatefulMcpRequest[];
  /** Sessions initialized and not yet closed by a client DELETE. */
  readonly liveSessions: ReadonlySet<string>;
  /** Resolves with the first answered request that matches, already answered or not. */
  waitForRequest(match: (request: StatefulMcpRequest) => boolean): Promise<StatefulMcpRequest>;
  /**
   * Holds the next matching request until `release()`, the way a server that
   * stopped answering would. It still ends when the client aborts it.
   */
  hold(match: (request: StatefulMcpRequestShape) => boolean): HeldRequest;
  /** Answers the next matching request with `401`, the way a server rejecting the bearer would. */
  rejectUnauthorized(match: (request: StatefulMcpRequestShape) => boolean): void;
}

/**
 * A stateful 2025-era MCP server built from the MCP SDK's own transport, one
 * transport per session, routed by `mcp-session-id` the way the SDK's examples
 * do. It enforces the session rules real servers do: requests other than
 * `initialize` need a known session (400 without one, 404 for an unknown one),
 * a second standalone GET stream gets 409, and DELETE ends the session.
 */
export function createStatefulMcpServer(): StatefulMcpServer {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const liveSessions = new Set<string>();
  const requests: StatefulMcpRequest[] = [];
  const waiters: {
    match: (request: StatefulMcpRequest) => boolean;
    resolve: (request: StatefulMcpRequest) => void;
  }[] = [];
  const holds: {
    match: (request: StatefulMcpRequestShape) => boolean;
    arrive: () => void;
    released: Promise<void>;
  }[] = [];
  const unauthorized: ((request: StatefulMcpRequestShape) => boolean)[] = [];

  async function shapeOf(request: Request): Promise<StatefulMcpRequestShape> {
    const body: unknown = request.method === "POST" ? await request.clone().json() : undefined;
    const rpcMethod =
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      typeof body.method === "string"
        ? body.method
        : undefined;
    return { method: request.method, rpcMethod };
  }

  async function waitIfHeld(request: Request, shape: StatefulMcpRequestShape): Promise<void> {
    const held = holds.find((candidate) => candidate.match(shape));
    if (held === undefined) return;
    holds.splice(holds.indexOf(held), 1);
    held.arrive();
    const signal = request.signal;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      void held.released.then(resolve);
    });
  }

  function record(request: Request, shape: StatefulMcpRequestShape, response: Response): Response {
    const entry = {
      ...shape,
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
      const shape = await shapeOf(request);
      await waitIfHeld(request, shape);
      const refused = unauthorized.findIndex((match) => match(shape));
      if (refused !== -1) {
        unauthorized.splice(refused, 1);
        return record(request, shape, new Response(null, { status: 401 }));
      }
      return record(request, shape, await handle(request));
    },
    hold: (match) => {
      let arrive!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ arrive, match, released });
      return { reached, release };
    },
    liveSessions,
    rejectUnauthorized: (match) => {
      unauthorized.push(match);
    },
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
