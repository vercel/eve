import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { buildApplication } from "#internal/nitro/host.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

// Paths a bundler or asset store would mangle if it handled files by name or
// as text: Latin-1 bytes, an empty file, URL syntax, and a replaced token.
const SKILL_FILES = {
  "SKILL.md": "---\ndescription: Kennel handbook.\n---\n\nRead the references.\n",
  "references/latin1.md": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  "references/empty.md": "",
  "references/q?x#y.md": "Query and hash.\n",
  "import.meta.dev/note.md": "Keep import.meta.dev as written.\n",
} as const;

interface HostedServer {
  fetch(
    request: Request,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response>;
}

describe("hosted output carries eve-generated data verbatim", () => {
  let handbook: { readonly description: string; readonly bytes: Record<string, string> };

  // One build serves every case; the app root is removed after the first test.
  beforeAll(async () => {
    const { appRoot } = await createAppRoot("eve-generated-host-data-");
    const files: Record<string, string | Buffer> = {
      "agent/agent.ts": [
        'import { defineAgent } from "eve";',
        "export default defineAgent({",
        '  description: "Describes import.meta.dev without evaluating it.",',
        '  model: "openai/gpt-5.4-mini",',
        "});",
        "",
      ].join("\n"),
      "agent/instructions.md": "Answer kennel questions.\n",
      "agent/channels/handbook.ts": [
        'import { defineChannel, GET } from "eve/channels";',
        "export default defineChannel({",
        "  routes: [",
        '    GET("/handbook", async (_request, { describe, listSkillFiles, readSkill }) => {',
        '      const files = await listSkillFiles("kennel-handbook");',
        "      const bytes = {};",
        "      for (const { path } of files) {",
        '        bytes[path] = Buffer.from(await readSkill("kennel-handbook", path)).toString("hex");',
        "      }",
        "      return Response.json({ description: (await describe()).description, bytes });",
        "    }),",
        "  ],",
        "});",
        "",
      ].join("\n"),
      ...Object.fromEntries(
        Object.entries(SKILL_FILES).map(([path, contents]) => [
          `agent/skills/kennel-handbook/${path}`,
          contents,
        ]),
      ),
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(appRoot, path)), { recursive: true });
      await writeFile(join(appRoot, path), contents);
    }

    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: true });
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_generated_host_data");
    const server = (
      (await import(
        pathToFileURL(join(outputDir, "functions", "__server.func", "index.mjs")).href
      )) as { default: HostedServer }
    ).default;
    const response = await server.fetch(new Request("https://example.com/handbook"), {
      waitUntil() {},
    });
    expect(response.status).toBe(200);
    handbook = (await response.json()) as typeof handbook;
  }, 120_000);

  it("keeps manifest text that names a Nitro build constant", () => {
    expect(handbook.description).toBe("Describes import.meta.dev without evaluating it.");
  });

  it("serves every skill file byte for byte", () => {
    expect(handbook.bytes).toEqual(
      Object.fromEntries(
        Object.entries(SKILL_FILES).map(([path, contents]) => [
          path,
          Buffer.from(contents).toString("hex"),
        ]),
      ),
    );
  });
});
