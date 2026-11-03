#!/usr/bin/env node
/**
 * Retargets @eve/agent-browser at an agent-browser release. The package vendors the
 * release's MCP catalog and sandbox helpers, so a bump refreshes those files from the
 * upstream tag, moves the README pins, and adds a changeset.
 *
 *   node .github/scripts/agent-browser-bump.mjs sync [version]
 *   node .github/scripts/agent-browser-bump.mjs commit-payload <file>...
 *
 * `sync` defaults to the npm `latest` version, does nothing unless it is newer than the
 * pin, and prints a Markdown summary of the catalog changes for the pull request.
 */
import { execFileSync } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PACKAGE_DIR = "packages/eve-agent-browser";
const LIB = `${PACKAGE_DIR}/extension/lib`;
const TOOLS_DIR = `${PACKAGE_DIR}/extension/tools`;
const README = `${PACKAGE_DIR}/README.md`;
const UPSTREAM = "https://raw.githubusercontent.com/vercel-labs/agent-browser";
const TOOL_PREFIX = "agent_browser_";

/** Vendored file in extension/lib → its path in the upstream repository. */
export const VENDORED = {
  "mcp-tools.json": "packages/@agent-browser/sandbox/mcp-tools.json",
  "shared.ts": "packages/@agent-browser/sandbox/src/shared.ts",
  "version.ts": "packages/@agent-browser/sandbox/src/version.ts",
};

export function parsePin(source) {
  const match = /AGENT_BROWSER_SANDBOX_VERSION = "([^"]+)"/.exec(source);
  if (!match) throw new Error("No AGENT_BROWSER_SANDBOX_VERSION in version.ts.");
  return match[1];
}

/** True when `a` is a newer stable release than `b`. Prereleases never win. */
export function isNewer(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  const i = x.findIndex((n, j) => n !== y[j]);
  return i !== -1 && x[i] > y[i];
}

export function rewriteReadme(readme, from, to) {
  return readme
    .replace(
      /at (?:commit|tag) `[^`]+` \(agent-browser [^)]+\)/,
      `at tag \`v${to}\` (agent-browser ${to})`,
    )
    .replaceAll(`agent-browser ${from}`, `agent-browser ${to}`)
    .replaceAll(`agent-browser@${from}`, `agent-browser@${to}`);
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

export function summary({ from, to, diff }) {
  const list = (names) => names.map((name) => `\`${name}\``).join(", ") || "none";
  const exposedChanges = diff.changed.filter((tool) => tool.exposed).map((tool) => tool.name);
  const lines = [
    `Retargets \`@eve/agent-browser\` from agent-browser ${from} to [${to}](https://github.com/vercel-labs/agent-browser/releases/tag/v${to}), refreshing the vendored MCP catalog and sandbox helpers from that tag.`,
    "",
    "### Catalog changes",
    "",
    `- Added: ${list(diff.added)}`,
    `- Removed: ${list(diff.removed)}`,
    `- Changed, exposed by the extension: ${list(exposedChanges)}`,
    `- Changed, not exposed: ${list(diff.changed.filter((t) => !t.exposed).map((t) => t.name))}`,
  ];
  if (diff.broken.length > 0) {
    lines.push(
      "",
      `> [!WARNING]\n> The extension still exposes removed tools (${list(diff.broken)}), so the build fails until \`extension/tools\` drops them.`,
    );
  }
  lines.push(
    "",
    "Before merging, check new arguments on exposed tools against `APP_OWNED_ARGUMENTS` in `extension/lib/catalog.ts`, decide whether added tools should be exposed, and adjust the changeset level if the CLI minor changed.",
  );
  return lines.join("\n");
}

async function exposedTools() {
  const names = new Set();
  for (const file of await readdir(TOOLS_DIR)) {
    const source = await readFile(`${TOOLS_DIR}/${file}`, "utf8");
    for (const match of source.matchAll(/catalogTool(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

async function fetchUpstream(version, path) {
  const url = `${UPSTREAM}/v${version}/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GET ${url} returned ${response.status}. agent-browser ${version} is on npm, but its tag or ${path} is missing upstream.`,
    );
  }
  return response.text();
}

async function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
}

async function sync(requested) {
  const from = parsePin(await readFile(`${LIB}/version.ts`, "utf8"));
  const to =
    requested ??
    execFileSync("npm", ["view", "agent-browser", "version"], { encoding: "utf8" }).trim();
  if (!isNewer(to, from)) {
    console.error(`@eve/agent-browser targets agent-browser ${from}; ${to} is not newer.`);
    await setOutput({ changed: false });
    return;
  }

  const files = Object.fromEntries(
    await Promise.all(
      Object.entries(VENDORED).map(async ([name, path]) => [name, await fetchUpstream(to, path)]),
    ),
  );
  if (parsePin(files["version.ts"]) !== to) {
    throw new Error(`Upstream version.ts at v${to} does not pin ${to}.`);
  }

  const before = JSON.parse(await readFile(`${LIB}/mcp-tools.json`, "utf8"));
  const diff = diffCatalog(before, JSON.parse(files["mcp-tools.json"]), await exposedTools());

  const written = [];
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(`${LIB}/${name}`, contents);
    written.push(`${LIB}/${name}`);
  }
  await writeFile(README, rewriteReadme(await readFile(README, "utf8"), from, to));
  const changeset = `.changeset/agent-browser-${to.replaceAll(".", "-")}.md`;
  await writeFile(
    changeset,
    `---\n"@eve/agent-browser": patch\n---\n\nTarget agent-browser ${to}. The tool catalog and sandbox helpers match that release, and \`installSpec\` defaults to \`agent-browser@${to}\`.\n`,
  );
  // stdout carries the PR summary, so formatter output goes to stderr.
  execFileSync("pnpm", ["exec", "oxfmt", ...written, README, changeset], {
    stdio: ["ignore", 2, 2],
  });

  process.stdout.write(`${summary({ from, to, diff })}\n`);
  await setOutput({ changed: true, version: to });
}

/** GraphQL body for a GitHub-signed commit of `files` onto `branch` at `expectedHeadOid`. */
export async function commitPayload({ repository, branch, expectedHeadOid, version, files }) {
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
          headline: `chore(agent-browser): target agent-browser ${version}`,
          body: "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
        },
        fileChanges: { additions },
      },
    },
  };
}

async function main([command, ...args]) {
  if (command === "sync") return sync(args[0] || undefined);
  if (command === "commit-payload") {
    const { GITHUB_REPOSITORY, BRANCH, HEAD_OID, VERSION } = process.env;
    const payload = await commitPayload({
      repository: GITHUB_REPOSITORY,
      branch: BRANCH,
      expectedHeadOid: HEAD_OID,
      version: VERSION,
      files: args,
    });
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  throw new Error("Usage: agent-browser-bump.mjs sync [version] | commit-payload <file>...");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
