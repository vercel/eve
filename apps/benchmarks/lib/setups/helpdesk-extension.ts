import type { AuthoringSetup } from "../authoring-case.js";

const packageRoot = "packages/helpdesk";

/**
 * The extension package another team owns, kept as an npm workspace inside the
 * project. Its tools are deliberately plain: the consuming agent decides which
 * need approval and which it should not have at all.
 */
export const helpdeskExtensionFiles: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(
    {
      name: "@northwind/helpdesk",
      version: "1.4.0",
      private: true,
      type: "module",
      eve: { extension: { source: "./extension", dist: "./dist/extension" } },
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
        "./tools": { types: "./dist/tools/index.d.ts", default: "./dist/tools/index.mjs" },
      },
      scripts: { build: "eve extension build", typecheck: "tsc" },
      peerDependencies: { eve: "*", zod: "*" },
    },
    null,
    2,
  )}\n`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        types: ["node"],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["extension/**/*.ts"],
    },
    null,
    2,
  )}\n`,
  "README.md": `# @northwind/helpdesk

eve extension for Northwind Helpdesk. Maintained by the platform team; open a
request in #platform instead of editing it from an agent project.

Each mount works with one helpdesk queue.

## Configuration

| Key       | Required | Description                                                   |
| --------- | -------- | ------------------------------------------------------------- |
| \`token\`   | yes      | Helpdesk API token                                            |
| \`queue\`   | yes      | Queue the mount works with, such as \`support\`                  |
| \`baseUrl\` | no       | API base URL. Defaults to \`https://helpdesk.northwind.dev\`      |

## Tools

- \`search_tickets\`: search the queue's tickets
- \`create_ticket\`: open a ticket in the queue. Returns \`{ id, queue, status }\`
- \`close_ticket\`: close a ticket with a resolution. The helpdesk emails the customer
- \`delete_ticket\`: permanently delete a ticket
`,
  "extension/extension.ts": `import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    token: z.string(),
    queue: z.string(),
    baseUrl: z.string().url().default("https://helpdesk.northwind.dev"),
  }),
});
`,
  "extension/instructions.md": `You can work with Northwind Helpdesk tickets. Search for an existing ticket before
opening a new one, and include the ticket ID whenever you mention a ticket.
`,
  "extension/lib/helpdesk.ts": `import extension from "../extension.js";

export async function helpdesk(path: string, init: RequestInit = {}): Promise<unknown> {
  const { baseUrl, token } = extension.config;
  const headers: Record<string, string> = { authorization: \`Bearer \${token}\` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  if (!response.ok) throw new Error(\`Helpdesk request failed with \${response.status}.\`);
  return response.status === 204 ? null : response.json();
}

export function queuePath(path: string): string {
  return \`/v1/queues/\${encodeURIComponent(extension.config.queue)}\${path}\`;
}
`,
  "extension/tools/search_tickets.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

import { helpdesk, queuePath } from "../lib/helpdesk.js";

export default defineTool({
  description: "Search the helpdesk queue's tickets by keyword.",
  inputSchema: z.object({ query: z.string() }),
  async execute({ query }) {
    return helpdesk(\`\${queuePath("/tickets")}?q=\${encodeURIComponent(query)}\`);
  },
});
`,
  "extension/tools/create_ticket.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

import { helpdesk, queuePath } from "../lib/helpdesk.js";

export default defineTool({
  description: "Open a new helpdesk ticket in the queue for a customer.",
  inputSchema: z.object({
    customerEmail: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  async execute(input) {
    return (await helpdesk(queuePath("/tickets"), {
      method: "POST",
      body: JSON.stringify(input),
    })) as { id: string; queue: string; status: string };
  },
});
`,
  "extension/tools/close_ticket.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

import { helpdesk } from "../lib/helpdesk.js";

export default defineTool({
  description: "Close a helpdesk ticket with a resolution. The helpdesk emails the customer.",
  inputSchema: z.object({ ticketId: z.string(), resolution: z.string() }),
  async execute({ ticketId, resolution }) {
    return helpdesk(\`/v1/tickets/\${encodeURIComponent(ticketId)}/close\`, {
      method: "POST",
      body: JSON.stringify({ resolution }),
    });
  },
});
`,
  "extension/tools/delete_ticket.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

import { helpdesk } from "../lib/helpdesk.js";

export default defineTool({
  description: "Permanently delete a helpdesk ticket.",
  inputSchema: z.object({ ticketId: z.string() }),
  async execute({ ticketId }) {
    return helpdesk(\`/v1/tickets/\${encodeURIComponent(ticketId)}\`, { method: "DELETE" });
  },
});
`,
};

const addWorkspaceDependency = `const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.workspaces = ["${packageRoot}"];
pkg.dependencies = { ...pkg.dependencies, "@northwind/helpdesk": "^1.4.0" };
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
`;

export const helpdeskExtensionSetup: AuthoringSetup = {
  id: "helpdesk-extension-v1",
  async onSession({ run, write }) {
    for (const [path, content] of Object.entries(helpdeskExtensionFiles)) {
      await write(`${packageRoot}/${path}`, content);
    }
    await write("/tmp/add-helpdesk-workspace.cjs", addWorkspaceDependency);
    await run("node /tmp/add-helpdesk-workspace.cjs && rm /tmp/add-helpdesk-workspace.cjs");
    // \`eve build\` evaluates the mount, which needs the token wherever the project builds.
    await write(".env.local", "HELPDESK_TOKEN=local-helpdesk-token\n");
    await run("npm install");
    // The agent's typecheck reads the package's declarations, which the build emits.
    await run("npm run build --workspace @northwind/helpdesk");
  },
};
