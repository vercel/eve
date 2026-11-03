#!/usr/bin/env node
/**
 * Retargets an agent CLI extension (@eve/agent-browser, @eve/agent-desktop) at a newer
 * release of the CLI it installs. A bump moves the version pin, refreshes any files the
 * package vendors from the upstream tag, updates README pins, and adds a changeset.
 *
 *   node .github/scripts/agent-cli-bump.mjs sync <cli> [version]
 *   node .github/scripts/agent-cli-bump.mjs commit-payload <file>...
 *
 * `sync` defaults to the npm `latest` version, does nothing unless it is newer than the
 * pin, and prints a Markdown summary for the pull request.
 */
import { execFileSync } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TOOL_PREFIX = "agent_browser_";

/** Each CLI's extension package, where it pins the version, and what it vendors. */
export const CLIS = {
  "agent-browser": {
    workspace: "@eve/agent-browser",
    dir: "packages/eve-agent-browser",
    upstream: "vercel-labs/agent-browser",
    pin: { file: "extension/lib/version.ts", constant: "AGENT_BROWSER_SANDBOX_VERSION" },
    /** Path in the package → path in the upstream repository at the release tag. */
    vendored: {
      "extension/lib/mcp-tools.json": "packages/@agent-browser/sandbox/mcp-tools.json",
      "extension/lib/shared.ts": "packages/@agent-browser/sandbox/src/shared.ts",
      "extension/lib/version.ts": "packages/@agent-browser/sandbox/src/version.ts",
    },
    catalog: { file: "extension/lib/mcp-tools.json", tools: "extension/tools" },
    review:
      "check new arguments on exposed tools against `APP_OWNED_ARGUMENTS` in `extension/lib/catalog.ts`, decide whether added tools should be exposed, and adjust the changeset level if the CLI minor changed.",
  },
  "agent-desktop": {
    workspace: "@eve/agent-desktop",
    dir: "packages/eve-agent-desktop",
    upstream: "vercel-labs/agent-desktop",
    pin: { file: "extension/lib/sandbox.ts", constant: "AGENT_DESKTOP_VERSION" },
    vendored: {},
    review:
      "read the release notes for changed commands or flags. The `test-agent-desktop` CI job checks every tool's argv against this CLI version and drives a real desktop. Adjust the changeset level if the CLI minor changed.",
  },
};

const pinPattern = (constant) => new RegExp(`(${constant} = ")([^"]+)(")`);

export function parsePin(source, constant) {
  const match = pinPattern(constant).exec(source);
  if (!match) throw new Error(`No ${constant} = "<version>" found.`);
  return match[2];
}

export function writePin(source, constant, version) {
  parsePin(source, constant);
  return source.replace(pinPattern(constant), `$1${version}$3`);
}

/** True when `a` is a newer stable release than `b`. Prereleases never win. */
export function isNewer(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  const i = x.findIndex((n, j) => n !== y[j]);
  return i !== -1 && x[i] > y[i];
}

export function rewriteReadme(readme, cli, from, to) {
  return readme
    .replace(
      new RegExp(`at (?:commit|tag) \`[^\`]+\` \\(${cli} [^)]+\\)`),
      `at tag \`v${to}\` (${cli} ${to})`,
    )
    .replaceAll(`${cli} ${from}`, `${cli} ${to}`)
    .replaceAll(`${cli}@${from}`, `${cli}@${to}`);
}

/** Catalog tool changes, plus the exposed tools a removal would break. */
export function diffCatalog(before, after, exposed) {
  const index = (catalog) =>
    new Map(catalog.tools.map((tool) => [tool.name.slice(TOOL_PREFIX.length), tool]));
  const [old, next] = [index(before), index(after)];
  const added = [...next.keys()].filter((name) => !old.has(name));
  const removed = [...old.keys()].filter((name) => !next.has(name));
  const changed = [...next.keys()].filter(
    (name) => old.has(name) && JSON.stringify(old.get(name)) !== JSON.stringify(next.get(name)),
  );
  return {
    added,
    removed,
    changed: changed.map((name) => ({ name, exposed: exposed.has(name) })),
    broken: removed.filter((name) => exposed.has(name)),
  };
}

export function summary({ cli, from, to, diff }) {
  const { workspace, upstream, review, vendored } = CLIS[cli];
  const refreshed =
    Object.keys(vendored).length > 0 ? ", refreshing its vendored files from that tag" : "";
  const list = (names) => names.map((name) => `\`${name}\``).join(", ") || "none";
  const lines = [
    `Retargets \`${workspace}\` from ${cli} ${from} to [${to}](https://github.com/${upstream}/releases/tag/v${to})${refreshed}.`,
  ];
  if (diff) {
    const exposed = diff.changed.filter((t) => t.exposed).map((t) => t.name);
    const hidden = diff.changed.filter((t) => !t.exposed).map((t) => t.name);
    lines.push(
      "",
      "### Catalog changes",
      "",
      `- Added: ${list(diff.added)}`,
      `- Removed: ${list(diff.removed)}`,
      `- Changed, exposed by the extension: ${list(exposed)}`,
      `- Changed, not exposed: ${list(hidden)}`,
    );
    if (diff.broken.length > 0) {
      lines.push(
        "",
        `> [!WARNING]\n> The extension still exposes removed tools (${list(diff.broken)}), so the build fails until \`extension/tools\` drops them.`,
      );
    }
  }
  lines.push("", `Before merging, ${review}`);
  return lines.join("\n");
}

async function exposedTools(dir) {
  const names = new Set();
  for (const file of await readdir(dir)) {
    const source = await readFile(`${dir}/${file}`, "utf8");
    for (const match of source.matchAll(/catalogTool(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

async function fetchUpstream(upstream, version, path) {
  const url = `https://raw.githubusercontent.com/${upstream}/v${version}/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GET ${url} returned ${response.status}. The release is on npm, but its tag or ${path} is missing upstream.`,
    );
  }
  return response.text();
}

async function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
}

async function sync(cli, requested) {
  const config = CLIS[cli];
  if (!config) throw new Error(`Unknown CLI "${cli}". Expected one of: ${Object.keys(CLIS)}.`);
  const { dir, pin, upstream, vendored, catalog, workspace } = config;
  const pinFile = `${dir}/${pin.file}`;
  const from = parsePin(await readFile(pinFile, "utf8"), pin.constant);
  const to =
    requested ?? execFileSync("npm", ["view", cli, "version"], { encoding: "utf8" }).trim();
  if (!isNewer(to, from)) {
    console.error(`${workspace} targets ${cli} ${from}; ${to} is not newer.`);
    await setOutput({ changed: false });
    return;
  }

  const files = Object.fromEntries(
    await Promise.all(
      Object.entries(vendored).map(async ([local, path]) => [
        local,
        await fetchUpstream(upstream, to, path),
      ]),
    ),
  );
  const diff = catalog
    ? diffCatalog(
        JSON.parse(await readFile(`${dir}/${catalog.file}`, "utf8")),
        JSON.parse(files[catalog.file]),
        await exposedTools(`${dir}/${catalog.tools}`),
      )
    : undefined;

  for (const [local, contents] of Object.entries(files)) {
    await writeFile(`${dir}/${local}`, contents);
  }
  // A vendored pin file was just replaced from upstream, so this also checks it has the pin.
  await writeFile(pinFile, writePin(await readFile(pinFile, "utf8"), pin.constant, to));
  const readme = `${dir}/README.md`;
  await writeFile(readme, rewriteReadme(await readFile(readme, "utf8"), cli, from, to));
  const changeset = `.changeset/${cli}-${to.replaceAll(".", "-")}.md`;
  const catalogNote = catalog
    ? ", and the tool catalog and sandbox helpers match that release"
    : "";
  await writeFile(
    changeset,
    `---\n"${workspace}": patch\n---\n\nTarget ${cli} ${to}. Sandbox installs default to \`${cli}@${to}\`${catalogNote}.\n`,
  );
  const touched = new Set([
    ...Object.keys(files).map((local) => `${dir}/${local}`),
    pinFile,
    readme,
    changeset,
  ]);
  // stdout carries the PR summary, so formatter output goes to stderr.
  execFileSync("pnpm", ["exec", "oxfmt", ...touched], { stdio: ["ignore", 2, 2] });

  process.stdout.write(`${summary({ cli, from, to, diff })}\n`);
  await setOutput({ changed: true, version: to });
}

/** GraphQL body for a GitHub-signed commit of `files` onto `branch` at `expectedHeadOid`. */
export async function commitPayload({ repository, branch, expectedHeadOid, headline, files }) {
  const additions = await Promise.all(
    files.map(async (path) => ({ path, contents: (await readFile(path)).toString("base64") })),
  );
  return {
    query:
      "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { url } } }",
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        expectedHeadOid,
        message: {
          headline,
          body: "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
        },
        fileChanges: { additions },
      },
    },
  };
}

async function main([command, ...args]) {
  if (command === "sync") return sync(args[0], args[1] || undefined);
  if (command === "commit-payload") {
    const { GITHUB_REPOSITORY, BRANCH, HEAD_OID, TITLE } = process.env;
    const payload = await commitPayload({
      repository: GITHUB_REPOSITORY,
      branch: BRANCH,
      expectedHeadOid: HEAD_OID,
      headline: TITLE,
      files: args,
    });
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  throw new Error("Usage: agent-cli-bump.mjs sync <cli> [version] | commit-payload <file>...");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
