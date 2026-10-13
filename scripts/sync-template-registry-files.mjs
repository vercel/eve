#!/usr/bin/env node
// Templates vendor some registry files unchanged so registry fixes reach them.
// `--check` fails on drift (CI); without it, copies the registry files over.
// Each copy must be `linguist-generated` in .gitattributes so GitHub collapses it.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const docsRoot = join(repoRoot, "apps", "docs");

const vendored = [
  {
    template: "eve-voice-template",
    item: "channel/web",
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
];

const check = process.argv.includes("--check");
const registry = JSON.parse(readFileSync(join(docsRoot, "registry.json"), "utf8"));
const problems = [];

for (const { template, item, files } of vendored) {
  const entry = registry.items.find((candidate) => candidate.name === item);
  if (!entry) throw new Error(`Registry item "${item}" not found in apps/docs/registry.json`);
  const templateRoot = join(repoRoot, "apps", "templates", template);
  const manifest = JSON.parse(readFileSync(join(templateRoot, "package.json"), "utf8"));

  for (const file of files) {
    const registryFile = entry.files.find(
      (candidate) => candidate.path === `registry/${item}/${file}`,
    );
    if (!registryFile) {
      problems.push(`${template}: "${file}" is no longer part of registry item "${item}"`);
      continue;
    }
    const source = join(docsRoot, registryFile.path);
    const destination = join(templateRoot, registryFile.target);
    const contents = readFileSync(source, "utf8");
    for (const [, specifier] of contents.matchAll(/from "([^"./@][^"]*|@[^"/]+\/[^"]+)"/g)) {
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (!manifest.dependencies?.[name]) {
        problems.push(
          `${template}: ${registryFile.target} imports "${name}", which is not a dependency`,
        );
      }
    }

    const attribute = execFileSync("git", ["check-attr", "linguist-generated", "--", destination], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (!attribute.trimEnd().endsWith(": set")) {
      problems.push(
        `${template}: ${registryFile.target} is not linguist-generated in .gitattributes`,
      );
    }

    if (existsSync(destination) && readFileSync(destination, "utf8") === contents) continue;

    if (check) {
      problems.push(`${template}: ${registryFile.target} differs from ${registryFile.path}`);
    } else {
      copyFileSync(source, destination);
      console.log(`updated ${template}/${registryFile.target}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  if (check)
    console.error(
      "Run `pnpm sync:template-registry` to update the copies, and mark new ones `linguist-generated` in .gitattributes.",
    );
  process.exit(1);
}
