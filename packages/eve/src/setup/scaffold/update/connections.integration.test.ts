import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import { getCatalogEntry } from "../connections/catalog.js";
import { ensureConnection, listAuthoredConnections } from "./connections.js";

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "eve-connections-"));
}

function entry(slug: string) {
  const value = getCatalogEntry(slug);
  if (value === undefined) throw new Error(`missing catalog entry ${slug}`);
  return value;
}

describe("ensureConnection", () => {
  test("writes a Connect-auth MCP connection and patches package.json", async () => {
    const projectRoot = await createTempDir();
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "demo", type: "module" }, null, 2)}\n`,
      "utf8",
    );

    const result = await ensureConnection({
      projectRoot,
      protocol: "mcp",
      entry: entry("linear"),
      connectPackageVersion: "0.0.0-test",
    });

    expect(result.action).toBe("created");
    expect(result.slug).toBe("linear");
    expect(result.filePath).toBe(join(projectRoot, "agent/connections/linear.ts"));
    expect(result.envKeysRequired).toEqual([]);

    const source = await readFile(result.filePath, "utf8");
    expect(source).toContain('import { connect } from "@vercel/connect/eve";');
    expect(source).toContain("defineMcpClientConnection");
    expect(source).toContain('auth: connect("linear")');

    await expect(readFile(join(projectRoot, "package.json"), "utf8")).resolves.toContain(
      '"@vercel/connect": "0.0.0-test"',
    );
  });

  test("seeds .env.local placeholders for a bearer-env connection", async () => {
    const projectRoot = await createTempDir();

    const result = await ensureConnection({
      projectRoot,
      protocol: "mcp",
      entry: {
        slug: "notion",
        description: "Notion workspace: search and edit pages and databases.",
        protocols: ["mcp"],
        mcp: { url: "https://mcp.notion.com/mcp" },
        auth: { kind: "bearer-env", envVar: "NOTION_API_TOKEN" },
      },
    });

    expect(result.envKeysRequired).toEqual(["NOTION_API_TOKEN"]);
    expect(result.envKeysAdded).toEqual(["NOTION_API_TOKEN"]);
    expect(result.packageJsonUpdated).toEqual([]);

    const source = await readFile(result.filePath, "utf8");
    expect(source).not.toContain("@vercel/connect");
    expect(source).toContain("process.env.NOTION_API_TOKEN");

    await expect(readFile(join(projectRoot, ".env.local"), "utf8")).resolves.toContain(
      "NOTION_API_TOKEN=",
    );
  });

  test("emits header auth for multi-key connections", async () => {
    const projectRoot = await createTempDir();

    const result = await ensureConnection({
      projectRoot,
      protocol: "mcp",
      entry: {
        slug: "datadog",
        description: "Datadog: query metrics, monitors, logs, and incidents.",
        protocols: ["mcp"],
        mcp: { url: "https://mcp.datadoghq.com/api/mcp" },
        auth: {
          kind: "header",
          headers: [
            { header: "DD-API-KEY", envVar: "DD_API_KEY" },
            { header: "DD-APPLICATION-KEY", envVar: "DD_APP_KEY" },
          ],
        },
      },
    });

    expect(result.envKeysRequired).toEqual(["DD_API_KEY", "DD_APP_KEY"]);
    const source = await readFile(result.filePath, "utf8");
    expect(source).toContain('"DD-API-KEY": process.env.DD_API_KEY!');
    expect(source).toContain('"DD-APPLICATION-KEY": process.env.DD_APP_KEY!');
  });

  test("skips an existing connection unless force is set", async () => {
    const projectRoot = await createTempDir();
    const filePath = join(projectRoot, "agent/connections/linear.ts");
    await mkdir(join(projectRoot, "agent/connections"), { recursive: true });
    await writeFile(filePath, "existing\n", "utf8");

    const skipped = await ensureConnection({
      projectRoot,
      protocol: "mcp",
      entry: entry("linear"),
      connectPackageVersion: "0.0.0-test",
    });
    expect(skipped.action).toBe("skipped");
    expect(skipped.filesSkipped).toEqual([filePath]);
    await expect(readFile(filePath, "utf8")).resolves.toBe("existing\n");

    const overwritten = await ensureConnection({
      projectRoot,
      protocol: "mcp",
      entry: entry("linear"),
      force: true,
      connectPackageVersion: "0.0.0-test",
    });
    expect(overwritten.action).toBe("overwritten");
    expect(overwritten.filesOverwritten).toEqual([filePath]);
    await expect(readFile(filePath, "utf8")).resolves.toContain("defineMcpClientConnection");
  });

  test("scaffolds a custom MCP connection", async () => {
    const projectRoot = await createTempDir();

    const result = await ensureConnection({
      projectRoot,
      slug: "mycorp",
      protocol: "mcp",
      entry: {
        slug: "mycorp",
        description: "Internal tools.",
        protocols: ["mcp"],
        mcp: { url: "https://mcp.mycorp.dev/sse" },
      },
    });

    expect(result.action).toBe("created");
    const source = await readFile(result.filePath, "utf8");
    expect(source).toContain('url: "https://mcp.mycorp.dev/sse"');
    expect(source).toContain("Internal tools.");
  });

  test("rejects a protocol the entry does not declare an endpoint for", async () => {
    const projectRoot = await createTempDir();
    await expect(
      ensureConnection({
        projectRoot,
        protocol: "openapi",
        entry: entry("linear"),
      }),
    ).rejects.toThrow(/missing a openapi.spec endpoint/);
  });
});

describe("listAuthoredConnections", () => {
  test("returns an empty list when the directory is absent", async () => {
    const projectRoot = await createTempDir();
    await expect(listAuthoredConnections(projectRoot)).resolves.toEqual([]);
  });

  test("lists file- and folder-form connections, sorted", async () => {
    const projectRoot = await createTempDir();
    const dir = join(projectRoot, "agent/connections");
    await mkdir(join(dir, "datadog"), { recursive: true });
    await writeFile(join(dir, "linear.ts"), "export default {}\n", "utf8");
    await writeFile(join(dir, "datadog", "connection.ts"), "export default {}\n", "utf8");
    await writeFile(join(dir, "README.md"), "ignore me\n", "utf8");

    await expect(listAuthoredConnections(projectRoot)).resolves.toEqual(["datadog", "linear"]);
  });
});
