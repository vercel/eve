interface McpJsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    tools?: McpTool[];
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
}

function parseMcpBody(text: string): McpJsonRpcMessage | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as McpJsonRpcMessage;
  } catch {
    const messages: McpJsonRpcMessage[] = [];

    for (const line of trimmed.split("\n")) {
      const row = line.trim();
      if (!row.startsWith("data:")) {
        continue;
      }

      const payload = row.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      try {
        messages.push(JSON.parse(payload) as McpJsonRpcMessage);
      } catch {
        // ignore malformed SSE chunks
      }
    }

    return messages.find((message) => message.result || message.error) ?? messages.at(-1) ?? null;
  }
}

async function linearMcpRequest(token: string, message: McpJsonRpcMessage, sessionId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const res = await fetch("https://mcp.linear.app/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  const text = await res.text();
  const data = parseMcpBody(text);

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    data,
    sessionId: res.headers.get("Mcp-Session-Id") ?? sessionId,
    raw: text.slice(0, 500),
  };
}

function formatIssue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const issue = value as {
    identifier?: string;
    title?: string;
    name?: string;
    id?: string;
  };

  if (issue.identifier && issue.title) {
    return `${issue.identifier} — ${issue.title}`;
  }

  if (issue.title) {
    return issue.title;
  }

  if (issue.name) {
    return issue.name;
  }

  return null;
}

function extractMcpResults(message: McpJsonRpcMessage | null): {
  results: string[];
  error?: string;
} {
  const content = message?.result?.content;
  if (!content?.length) {
    return { results: [] };
  }

  const results: string[] = [];

  for (const block of content) {
    if (block.type !== "text" || !block.text) {
      continue;
    }

    if (/^(MCP error|Input validation error)/i.test(block.text.trim())) {
      return { results: [], error: block.text.trim() };
    }

    try {
      const parsed = JSON.parse(block.text) as unknown;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const formatted = formatIssue(item);
          if (formatted) {
            results.push(formatted);
          }
        }
        continue;
      }

      if (parsed && typeof parsed === "object") {
        const record = parsed as {
          items?: unknown[];
          issues?: unknown[];
          nodes?: unknown[];
        };

        for (const collection of [record.items, record.issues, record.nodes]) {
          if (!Array.isArray(collection)) {
            continue;
          }

          for (const item of collection) {
            const formatted = formatIssue(item);
            if (formatted) {
              results.push(formatted);
            }
          }
        }

        if (results.length) {
          continue;
        }
      }
    } catch {
      // fall through to plain text
    }

    for (const line of block.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      results.push(formatPlainIssueLine(line));
    }
  }

  return { results: results.slice(0, 5) };
}

function formatPlainIssueLine(line: string): string {
  const cleaned = line
    .replace(/^[-*]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();

  const tagged = cleaned.match(/^(\[[^\]]+\])\s*(.+)$/);
  if (tagged?.[1] && tagged[2]) {
    const body = tagged[2];
    const withId = body.match(/^([A-Z]+-\d+)\s*[:\u2014-]\s*(.+)$/);
    if (withId?.[1] && withId[2]) {
      return `${withId[1]} — ${withId[2]}`;
    }
    return `${tagged[1]} ${body}`;
  }

  const withId = cleaned.match(/^([A-Z]+-\d+)\s*[:\u2014-]\s*(.+)$/);
  if (withId?.[1] && withId[2]) {
    return `${withId[1]} — ${withId[2]}`;
  }

  return cleaned;
}

function buildListIssuesArgs(tool: McpTool) {
  const properties = tool.inputSchema?.properties ?? {};

  if ("limit" in properties) {
    return { limit: 5 };
  }

  if ("first" in properties) {
    return { first: 5 };
  }

  return {};
}

function pickListIssuesTool(tools: McpTool[]) {
  const preferred = ["list_issues", "search_issues", "listIssues", "get_issues"];
  return (
    tools.find((tool) => preferred.includes(tool.name)) ??
    tools.find((tool) => /issues/i.test(tool.name))
  );
}

export async function fetchLinearIssuesViaMcp(token: string) {
  const init = await linearMcpRequest(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "v", version: "1.0.0" },
    },
  });

  if (!init.ok || init.data?.error) {
    return {
      ok: false as const,
      error:
        init.data?.error?.message ?? `Linear MCP init failed: ${init.status} ${init.statusText}`,
    };
  }

  let sessionId = init.sessionId;

  await linearMcpRequest(
    token,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    sessionId,
  );

  const toolsList = await linearMcpRequest(
    token,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    },
    sessionId,
  );

  if (!toolsList.ok || toolsList.data?.error) {
    return {
      ok: false as const,
      error: toolsList.data?.error?.message ?? `Linear MCP tools/list failed: ${toolsList.status}`,
    };
  }

  sessionId = toolsList.sessionId ?? sessionId;
  const tools = toolsList.data?.result?.tools ?? [];
  const listTool = pickListIssuesTool(tools);

  if (!listTool) {
    if (tools.length) {
      return {
        ok: true as const,
        results: tools.slice(0, 5).map((tool) => tool.name),
      };
    }

    return {
      ok: false as const,
      error: "Linear MCP returned no tools",
    };
  }

  const call = await linearMcpRequest(
    token,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: listTool.name,
        arguments: buildListIssuesArgs(listTool),
      },
    },
    sessionId,
  );

  if (!call.ok || call.data?.error) {
    return {
      ok: false as const,
      error: call.data?.error?.message ?? `Linear MCP ${listTool.name} failed: ${call.status}`,
    };
  }

  const { results, error } = extractMcpResults(call.data);
  if (error) {
    return { ok: false as const, error };
  }

  if (!results.length) {
    return {
      ok: false as const,
      error: `Linear MCP ${listTool.name} returned no issues`,
    };
  }

  return { ok: true as const, results };
}

export async function fetchLinearIssuesViaGraphql(token: string) {
  for (const authorization of [`Bearer ${token}`, token]) {
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "{ viewer { name } issues(first: 5) { nodes { identifier title } } }",
        }),
      });

      const body = (await res.json().catch(() => null)) as {
        data?: {
          viewer?: { name?: string };
          issues?: { nodes: Array<{ identifier: string; title: string }> };
        };
        errors?: Array<{ message: string }>;
      } | null;

      if (!res.ok) {
        continue;
      }

      if (body?.errors?.length) {
        continue;
      }

      const issues = body?.data?.issues?.nodes ?? [];
      const viewer = body?.data?.viewer?.name;

      if (!issues.length) {
        return {
          ok: true as const,
          results: viewer
            ? [`Signed in as ${viewer} (no issues yet)`]
            : ["Connected (no issues yet)"],
        };
      }

      return {
        ok: true as const,
        results: issues.map((issue) => `${issue.identifier} — ${issue.title}`),
      };
    } catch {
      // try next auth format
    }
  }

  return {
    ok: false as const,
    error: "Linear GraphQL API rejected the token",
  };
}
