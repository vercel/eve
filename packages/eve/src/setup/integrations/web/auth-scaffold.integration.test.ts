import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WEB_APP_TEMPLATE_FILES,
  WEB_CHANNEL_TEMPLATES,
} from "#setup/scaffold/create/web-template.js";
import { prepareWebAuthScaffold } from "./auth-scaffold.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(member = "") {
  const environmentRoot = await mkdtemp(join(tmpdir(), "eve-web-auth-"));
  roots.push(environmentRoot);
  const agentAppRoot = join(environmentRoot, member);
  const channelPath = join(agentAppRoot, "agent/channels/eve.ts");
  const packagePath = join(environmentRoot, "package.json");
  await mkdir(dirname(channelPath), { recursive: true });
  await writeFile(channelPath, WEB_CHANNEL_TEMPLATES.default);
  await writeFile(
    packagePath,
    JSON.stringify({
      scripts: { "dev:all": "vercel dev --local" },
      dependencies: { eve: "latest" },
    }),
  );
  for (const [path, source] of Object.entries(WEB_APP_TEMPLATE_FILES)) {
    const file = join(environmentRoot, "apps/web", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source.replaceAll("__EVE_INIT_APP_NAME__", "eve Next.js Starter"));
  }
  return { environmentRoot, agentAppRoot, channelPath, packagePath };
}

describe("Web Chat auth scaffold", () => {
  it.each(["", "agents/support"])(
    "wires the real channel to the shared auth module from %s and can be retried",
    async (member) => {
      const input = await fixture(member);
      const layoutPath = join(input.environmentRoot, "apps/web/app/layout.tsx");
      const layout = await readFile(layoutPath, "utf8");
      const write = await prepareWebAuthScaffold(input);
      await write();
      const signIn = await readFile(
        join(input.environmentRoot, "apps/web/app/_components/web-chat-auth.tsx"),
        "utf8",
      );
      expect(signIn).toContain(JSON.stringify(basename(input.agentAppRoot)));
      expect(signIn).not.toContain("__EVE_INIT_APP_NAME__");
      const channel = await readFile(input.channelPath, "utf8");
      const importPath = /import \{ auth \} from "(.+)"/.exec(channel)?.[1];
      expect(importPath).toBeDefined();
      expect(resolve(dirname(input.channelPath), importPath!)).toBe(
        join(input.environmentRoot, "apps/web/lib/auth.js"),
      );
      expect(await readFile(join(input.environmentRoot, "apps/web/lib/auth.ts"), "utf8")).toContain(
        'requireEnvironmentVariable("BETTER_AUTH_SECRET")',
      );
      const document = JSON.parse(await readFile(input.packagePath, "utf8"));
      expect(document.dependencies["better-auth"]).toBeDefined();
      expect(document.scripts["dev:all"]).toBe("vercel dev --local");
      expect(await readFile(layoutPath, "utf8")).toBe(layout);
      await (
        await prepareWebAuthScaffold(input)
      )();
      expect(await readFile(input.channelPath, "utf8")).toBe(channel);
    },
  );

  it("rejects custom auth before the caller provisions resources or writes files", async () => {
    const input = await fixture();
    await writeFile(input.channelPath, "// existing application auth\n");
    await expect(prepareWebAuthScaffold(input)).rejects.toThrow("contains authored code");
    expect(await readFile(input.channelPath, "utf8")).toBe("// existing application auth\n");
    expect(
      JSON.parse(await readFile(input.packagePath, "utf8")).dependencies["better-auth"],
    ).toBeUndefined();
  });
});
