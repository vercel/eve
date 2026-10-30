import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const url = "https://mcp.crm.example.com/mcp";

test("declares an MCP connection to the CRM", async () => {
  const connection = await crmConnection();
  expect(connection.url).toBe(url);
  expect(String(connection.description ?? "")).toMatch(/\S/);
});

test("authorizes each user through the Vercel Connect connector", async () => {
  const connection = await crmConnection();
  const auth = typeof connection.auth === "function" ? await connection.auth({}) : connection.auth;
  expect(auth?.vercelConnect?.connector).toBe("conn_crm_7f3a");
  expect(auth?.principalType ?? auth?.credentialOwner).toBe("user");
});

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function crmConnection(): Promise<any> {
  const file = files("agent/connections").find(
    (path) => path.endsWith(".ts") && resolvedSource(path).includes(url),
  );
  expect(file).toBeDefined();
  return (await import(pathToFileURL(resolve(file!)).href)).default;
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A module's source plus the project files it imports, so a URL kept in lib/ counts. */
function resolvedSource(path: string, seen = new Set<string>()): string {
  if (seen.has(path) || !existsSync(path)) return "";
  seen.add(path);
  const source = readFileSync(path, "utf8");
  const imported = [...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((match) => {
    const base = join(dirname(path), match[1]!.replace(/\.js$/, ""));
    return [base, `${base}.ts`, join(base, "index.ts")].find(
      (candidate) => existsSync(candidate) && candidate.endsWith(".ts"),
    );
  });
  return [source, ...imported.map((file) => (file ? resolvedSource(file, seen) : ""))].join("\n");
}
