import { describe, expect, it } from "vitest";

import type { AgentDescription } from "#channel/agent-description.js";
import { MAX_SKILL_FILE_BYTES } from "#channel/skill-files.js";
import { createMcpSkillsFeature } from "#internal/mcp/skills.js";
import { createMcpStreamableHttpServer } from "#internal/mcp/streamable-http-server.js";

/** A skill's files; `null` is listed by `describe()` but fails to read. */
type Files = Readonly<Record<string, string | Uint8Array | null>>;

const PROTOCOL = "2026-07-28";
const encode = (content: string | Uint8Array) =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;

function handler(skills: Readonly<Record<string, Files>>) {
  const describe = async (): Promise<AgentDescription> => ({
    name: "fixture",
    tools: [],
    skills: Object.entries(skills).map(([name, files]) => ({
      name,
      description: "Catalog description.",
      files: Object.entries(files)
        .map(([path, content]) => ({ path, size: content === null ? 1 : encode(content).length }))
        .sort((left, right) => (left.path < right.path ? -1 : 1)),
    })),
  });
  const readSkill = async (skill: string, path = "SKILL.md") => {
    const content = skills[skill]?.[path];
    if (content === undefined || content === null) throw new Error(`${skill}/${path} is gone`);
    return encode(content);
  };
  const mcp = createMcpStreamableHttpServer({
    authenticate: async () => null,
    features: [createMcpSkillsFeature({ describe, readSkill })],
    name: "eve-skills-test",
    version: "0.0.0",
  });
  return async (method: string, params: Record<string, unknown> = {}) => {
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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}
