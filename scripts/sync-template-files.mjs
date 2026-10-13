#!/usr/bin/env node
// Templates copy some files unchanged, from a registry item or from another
// template, so one fix reaches every copy. `--check` fails on drift (CI);
// without it, the sources are copied over. Each copy must be
// `linguist-generated` in .gitattributes so GitHub collapses it in reviews.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const docsRoot = join(repoRoot, "apps", "docs");
const templatesRoot = join(repoRoot, "apps", "templates");

const copies = [
  {
    template: "eve-voice-template",
    registry: "channel/web",
    files: [
      "app/_components/agent-message.tsx",
      "app/globals.css",
      "components/ai-elements/code-block.tsx",
      "components/ai-elements/conversation.tsx",
      "components/ai-elements/message.tsx",
      "components/ai-elements/reasoning.tsx",
      "components/ai-elements/shimmer.tsx",
      "components/ai-elements/tool.tsx",
      "components/ui/button-group.tsx",
      "components/ui/button.tsx",
      "components/ui/collapsible.tsx",
      "components/ui/questionnaire.tsx",
      "components/ui/select.tsx",
      "components/ui/separator.tsx",
      "components/ui/tooltip.tsx",
      "css.d.ts",
      "lib/utils.ts",
      "postcss.config.mjs",
    ],
  },
  {
    template: "eve-voice-template",
    from: "eve-chat-template",
    files: [
      ".gitignore",
      ".vercelignore",
      "AGENTS.md",
      "CLAUDE.md",
      "agent/channels/eve.ts",
      "agent/tools/get_weather.ts",
      "apps/web/app/icon.svg",
      "apps/web/drizzle.config.ts",
      "apps/web/lib/auth-client.ts",
      "apps/web/lib/auth-url.ts",
      "apps/web/lib/rate-limit.ts",
      "apps/web/tsconfig.json",
      "vercel.ts",
    ],
  },
];

const check = process.argv.includes("--check");
const registry = JSON.parse(readFileSync(join(docsRoot, "registry.json"), "utf8"));
const problems = [];

/** Resolves each listed file to its source and the template path it is copied to. */
function resolveFiles(copy) {
  if (copy.from !== undefined) {
    return copy.files.map((file) => ({
      source: join(templatesRoot, copy.from, file),
      target: file,
    }));
  }
  const item = registry.items.find((candidate) => candidate.name === copy.registry);
  if (!item)
    throw new Error(`Registry item "${copy.registry}" not found in apps/docs/registry.json`);
  return copy.files.flatMap((file) => {
    const entry = item.files.find(
      (candidate) => candidate.path === `registry/${copy.registry}/${file}`,
    );
    if (entry) return [{ source: join(docsRoot, entry.path), target: entry.target }];
    problems.push(
      `${copy.template}: "${file}" is no longer part of registry item "${copy.registry}"`,
    );
    return [];
  });
}

for (const copy of copies) {
  const templateRoot = join(templatesRoot, copy.template);
  const manifest = JSON.parse(readFileSync(join(templateRoot, "package.json"), "utf8"));

  for (const { source, target } of resolveFiles(copy)) {
    const destination = join(templateRoot, target);
    const label = `${copy.template}/${target}`;
    const contents = readFileSync(source, "utf8");

    for (const [, specifier] of contents.matchAll(/from "([^"./@][^"]*|@[^"/]+\/[^"]+)"/g)) {
      if (specifier.startsWith("node:")) continue;
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (!manifest.dependencies?.[name] && !manifest.devDependencies?.[name]) {
        problems.push(`${label} imports "${name}", which is not a dependency`);
      }
    }

    const attribute = execFileSync("git", ["check-attr", "linguist-generated", "--", destination], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (!attribute.trimEnd().endsWith(": set")) {
      problems.push(`${label} is not linguist-generated in .gitattributes`);
    }

    if (existsSync(destination) && readFileSync(destination, "utf8") === contents) continue;
    if (check) {
      problems.push(`${label} differs from ${relative(repoRoot, source)}`);
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      console.log(`updated ${label}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  if (check) {
    console.error(
      "Run `pnpm sync:template-files` to update the copies, and mark new ones `linguist-generated` in .gitattributes.",
    );
  }
  process.exit(1);
}
