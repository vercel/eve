import { describe, expect, it } from "vitest";

import {
  MAX_SKILL_FILE_BYTES,
  type SkillFileSource,
  SkillReadError,
} from "#channel/skill-files.js";
import { createMcpSkillsFeature, type McpSkillSource } from "#internal/mcp/skills.js";
import { createMcpStreamableHttpServer } from "#internal/mcp/streamable-http-server.js";

/**
 * A skill's files; `null` is listed but missing on read (a deterministic
 * `SkillReadError`), and a function is called per read so a test can fail
 * transiently.
 */
type Files = Readonly<Record<string, string | Uint8Array | null | (() => string)>>;

const PROTOCOL = "2026-07-28";
const encode = (content: string | Uint8Array) =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;

/**
 * A skill source as the route args provide one: the `skills` array is
 * stable for the life of the source, as a build's description is, and
 * `calls` counts listings and reads per skill.
 */
function skillSource(skills: Readonly<Record<string, Files>>) {
  const calls = { list: new Map<string, number>(), read: new Map<string, number>() };
  const count = (calls: Map<string, number>, key: string) =>
    calls.set(key, (calls.get(key) ?? 0) + 1);
  const files: SkillFileSource = {
    async listFiles(skill) {
      count(calls.list, skill);
      return Object.entries(skills[skill] ?? {})
        .map(([path, content]) => ({
          path,
          size: content === null || typeof content === "function" ? 1 : encode(content).length,
        }))
        .sort((left, right) => (left.path < right.path ? -1 : 1));
    },
    async readFile(skill, path) {
      count(calls.read, `${skill}/${path}`);
      const content = skills[skill]?.[path];
      if (content === undefined || content === null) {
        throw new SkillReadError("unknown-file", `Skill "${skill}" has no file "${path}".`);
      }
      return encode(typeof content === "function" ? content() : content);
    },
  };
  const source: McpSkillSource = {
    files,
    skills: Object.keys(skills).map((name) => ({ name, description: "Catalog description." })),
  };
  return { calls, source };
}

/** Every request builds a fresh server, as `mcpChannel` does. */
function handler(skills: Readonly<Record<string, Files>>, source = skillSource(skills).source) {
  return async (method: string, params: Record<string, unknown> = {}) => {
    const mcp = createMcpStreamableHttpServer({
      authenticate: async () => null,
      features: [createMcpSkillsFeature(source)],
      name: "eve-skills-test",
      version: "0.0.0",
    });
    const _meta = {
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "0.0.0" },
      "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    };
    const request = new Request("https://agent.example/eve/v1/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: { ...params, _meta } }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": PROTOCOL,
        ...(method === "resources/read" && { "mcp-name": String(params.uri) }),
      },
      method: "POST",
    });
    return (await (await mcp(request)).json()) as { result?: Record<string, any>; error?: object };
  };
}

/** Whether each surface serves a skill: skills/list, resources/list, get, read, directory. */
async function surfaces(call: ReturnType<typeof handler>, names: readonly string[]) {
  const listed = (await call("skills/list")).result?.skills.map((s: { uri: string }) => s.uri);
  const resources = (await call("resources/list")).result?.resources.map(
    (r: { uri: string }) => r.uri,
  );
  const served: Record<string, boolean[]> = {};
  for (const name of names) {
    const root = `skill://${encodeURIComponent(name)}`;
    const entry = `${root}/SKILL.md`;
    served[name] = [
      listed.includes(entry),
      resources.includes(entry),
      (await call("skills/get", { uri: entry })).result !== undefined,
      (await call("resources/read", { uri: entry })).result !== undefined,
      (await call("resources/read", { uri: `${root}/notes.md` })).result !== undefined,
      (await call("resources/directory/read", { uri: root })).result !== undefined,
    ];
  }
  return served;
}

const doc = (name: string, description: string) => ({
  "SKILL.md": `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nBody\n`,
  "notes.md": "notes\n",
});
const max = "a".repeat(64);
const every = Array(6).fill(true);
const none = Array(6).fill(false);
const bulky: Record<string, string> = doc("bulky", "Too much.");
for (let index = 0; index < 33; index += 1) {
  bulky[`data/part-${index}.txt`] = "z".repeat(MAX_SKILL_FILE_BYTES);
}
const crowded: Record<string, string> = doc("crowded", "Too many files.");
for (let index = 0; index < 511; index += 1) crowded[`data/${index}.txt`] = "";

describe("MCP skills (SEP-2640)", () => {
  it("serves a skill whole on every surface or not at all", async () => {
    // Without frontmatter, eve writes name and description from the catalog.
    const served: Record<string, Files> = {
      a: doc("a", "x"),
      [max]: doc(max, "d".repeat(1024)),
      "multi-byte": doc("multi-byte", "é".repeat(1024)),
      synthesized: { "SKILL.md": "Body\n", "notes.md": "notes\n" },
      "lower-entry": { "skill.md": "Body\n", "notes.md": "notes\n" },
    };
    const refused: Record<string, Files> = {
      Hello_World: doc("Hello_World", "Underscore."),
      [`${max}a`]: doc(`${max}a`, "Name too long."),
      "double--hyphen": doc("double--hyphen", "Consecutive hyphens."),
      "blank-desc": doc("blank-desc", "   "),
      "long-desc": doc("long-desc", "d".repeat(1025)),
      broken: { "SKILL.md": "---\nname: broken\ndescription: [unclosed\n---\n", "notes.md": "n" },
      binary: { "SKILL.md": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]), "notes.md": "n" },
      "no-entry": { "notes.md": "n" },
      "two-entries": { ...doc("two-entries", "Twice."), "skill.md": "Again\n" },
      "over-cap-file": {
        ...doc("over-cap-file", "Big."),
        "big.md": "x".repeat(MAX_SKILL_FILE_BYTES + 1),
      },
      unreadable: { ...doc("unreadable", "Gone."), "gone.md": null },
      bulky,
      crowded,
    };
    const call = handler({ ...served, ...refused });
    const result = await surfaces(call, [...Object.keys(served), ...Object.keys(refused)]);
    for (const name of Object.keys(served)) expect(result[name], name).toEqual(every);
    for (const name of Object.keys(refused)) expect(result[name], name).toEqual(none);

    const get = await call("skills/get", { uri: "skill://synthesized/SKILL.md" });
    const synthesized =
      '---\nname: "synthesized"\ndescription: "Catalog description."\n---\nBody\n';
    expect(get.result?.skill).toEqual({
      uri: "skill://synthesized/SKILL.md",
      frontmatter: { name: "synthesized", description: "Catalog description." },
      resources: [
        {
          uri: "skill://synthesized/SKILL.md",
          digest: `sha256:${await sha256(synthesized)}`,
          size: synthesized.length,
        },
        {
          uri: "skill://synthesized/notes.md",
          digest: `sha256:${await sha256("notes\n")}`,
          size: 6,
        },
      ],
    });
    const read = await call("resources/read", { uri: "skill://synthesized/SKILL.md" });
    expect(read.result?.contents).toEqual([
      { uri: "skill://synthesized/SKILL.md", mimeType: "text/markdown", text: synthesized },
    ]);
  });
});

describe("MCP skills catalog", () => {
  it("advertises resources without list-changed notifications", async () => {
    const call = handler({ hinted: doc("hinted", "Cached.") });
    const { result } = await call("server/discover");
    expect(result?.capabilities).toEqual({
      extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
      resources: { listChanged: false },
    });
  });

  it("lists and reads each skill once while its description is stable", async () => {
    const skills = { a: doc("a", "First."), b: doc("b", "Second.") };
    const { calls, source } = skillSource(skills);
    const call = handler(skills, source);
    for (let request = 0; request < 3; request += 1) {
      expect((await call("skills/list")).result?.skills).toHaveLength(2);
      expect((await call("resources/list")).result?.resources).toHaveLength(2);
      expect((await call("skills/get", { uri: "skill://a/SKILL.md" })).result).toBeDefined();
      expect((await call("resources/read", { uri: "skill://b/SKILL.md" })).result).toBeDefined();
    }
    expect([...calls.list]).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect([...calls.read]).toEqual([
      ["a/SKILL.md", 1],
      ["a/notes.md", 1],
      ["b/SKILL.md", 1],
      ["b/notes.md", 1],
    ]);

    // Only `SKILL.md` stays in memory; other files are read per request.
    expect((await call("resources/read", { uri: "skill://a/notes.md" })).result).toBeDefined();
    expect(calls.read.get("a/notes.md")).toBe(2);

    // A new description, as after a recompile, lists and reads again.
    const recompiled = skillSource(skills);
    expect((await handler(skills, recompiled.source)("skills/list")).result?.skills).toHaveLength(
      2,
    );
    expect([...recompiled.calls.list]).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("retries a skill whose file read failed transiently", async () => {
    let reads = 0;
    const skills = {
      flaky: {
        ...doc("flaky", "Reads once it settles."),
        "notes.md": () => {
          reads += 1;
          if (reads === 1) throw new Error("EIO: transient");
          return "notes\n";
        },
      },
    };
    const { calls, source } = skillSource(skills);
    const call = handler(skills, source);
    const first = await call("skills/list");
    expect(first.error).toBeDefined();
    expect(first.result).toBeUndefined();

    const second = await call("skills/list");
    expect(second.result?.skills.map((s: { uri: string }) => s.uri)).toEqual([
      "skill://flaky/SKILL.md",
    ]);
    expect(reads).toBe(2);
    expect(calls.list.get("flaky")).toBe(2);
  });

  it("retries a skill whose listing failed transiently", async () => {
    const skills = { listed: doc("listed", "Lists once it settles.") };
    const { source } = skillSource(skills);
    let listings = 0;
    const call = handler(skills, {
      ...source,
      files: {
        ...source.files,
        async listFiles(skill) {
          listings += 1;
          if (listings === 1) throw new Error("EIO: transient");
          return await source.files.listFiles(skill);
        },
      },
    });
    expect((await call("skills/list")).error).toBeDefined();
    expect((await call("skills/list")).result?.skills).toHaveLength(1);
    expect(listings).toBe(2);
  });

  it("carries the list cache hint on every skill and resource method", async () => {
    const call = handler({ hinted: doc("hinted", "Cached.") });
    const hint = { cacheScope: "private", ttlMs: 5 * 60 * 1000 };
    for (const [method, params] of [
      ["skills/list", {}],
      ["skills/get", { uri: "skill://hinted/SKILL.md" }],
      ["resources/list", {}],
      ["resources/templates/list", {}],
      ["resources/read", { uri: "skill://hinted/notes.md" }],
      ["resources/directory/read", { uri: "skill://hinted" }],
    ] as const) {
      const { result } = await call(method, params);
      expect(result, method).toMatchObject(hint);
    }
  });

  it("does not resolve MIME types from Object.prototype", async () => {
    const call = handler({
      proto: {
        ...doc("proto", "Prototype-named files."),
        "notes.constructor": "text\n",
        "x.__proto__": new Uint8Array([0, 1, 2]),
        "y.hasOwnProperty": "text\n",
      },
    });
    const read = async (path: string) =>
      (await call("resources/read", { uri: `skill://proto/${path}` })).result?.contents[0];
    expect(await read("notes.constructor")).toEqual({
      uri: "skill://proto/notes.constructor",
      mimeType: "text/plain",
      text: "text\n",
    });
    expect((await read("x.__proto__"))?.mimeType).toBe("application/octet-stream");
    expect((await read("y.hasOwnProperty"))?.mimeType).toBe("text/plain");
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}
