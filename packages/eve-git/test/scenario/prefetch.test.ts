import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import { buildPrefetchCommand, DEFAULT_PREFETCH_FILES } from "../../extension/lib/prefetch.ts";

const execFileAsync = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "eve-git test",
  GIT_AUTHOR_EMAIL: "eve-git@example.test",
  GIT_COMMITTER_NAME: "eve-git test",
  GIT_COMMITTER_EMAIL: "eve-git@example.test",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
};

let dir: string;
let workspace: string;
let remote: string;
let work: string;
let httpsServer: {
  readonly server: Server;
  readonly baseUrl: string;
  readonly repoUrl: string;
  readonly receivedHeaders: Array<Readonly<Record<string, string | string[] | undefined>>>;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eve-git-prefetch-"));
  workspace = join(dir, "workspace");
  remote = join(dir, "repo.git");
  const seed = join(dir, "seed");
  work = join(workspace, "work");

  await mkdir(workspace, { recursive: true });
  await git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await git(remote, "config", "uploadpack.allowFilter", "true");
  await git(remote, "config", "http.uploadpack", "true");
  await git(dir, "clone", "--quiet", remote, seed);
  await mkdir(join(seed, "docs"), { recursive: true });
  await mkdir(join(seed, "nested"), { recursive: true });
  await writeFile(join(seed, "AGENTS.md"), "# Agent rules\nRun focused tests.\n");
  await writeFile(join(seed, "docs", "GUIDE.md"), "Subdir guide.\n");
  await writeFile(join(seed, "nested", "file.txt"), "Tree entry content.\n");
  await symlink("AGENTS.md", join(seed, "LINK.md"));
  await writeFile(join(seed, "README.md"), "Not prefetched.\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "--quiet", "-m", "fixture");
  await git(seed, "push", "--quiet", "origin", "main");
  httpsServer = await startHttpsGitServer(dir);
});

afterEach(async () => {
  if (httpsServer) {
    httpsServer.server.closeAllConnections?.();
    await new Promise<void>((resolve) => httpsServer.server.close(() => resolve()));
  }
  await rm(dir, { recursive: true, force: true });
});

test("prefetches regular blobs over https into .git/objects without fetching symlinks, trees, or touching the worktree", async () => {
  const authHeader = `Basic ${Buffer.from("x-access-token:eve-github-placeholder").toString("base64")}`;
  const httpsEnv = {
    ...ENV,
    GIT_SSL_NO_VERIFY: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: `http.${httpsServer.baseUrl}/.extraheader`,
    GIT_CONFIG_VALUE_2: `Authorization: ${authHeader}`,
  };

  await execFileAsync(
    "git",
    ["clone", "--quiet", "--filter=blob:none", "--no-checkout", httpsServer.repoUrl, work],
    { cwd: dir, env: httpsEnv },
  );

  await assert.rejects(
    execFileAsync("git", ["-C", work, "show", "HEAD:AGENTS.md"], {
      env: { ...httpsEnv, GIT_NO_LAZY_FETCH: "1" },
    }),
  );

  httpsServer.receivedHeaders.length = 0;

  const command = buildPrefetchCommand(work, workspace, [
    ...DEFAULT_PREFETCH_FILES,
    "docs/GUIDE.md",
    "LINK.md",
    "nested",
  ]);
  assert.ok(command);
  await execFileAsync("/bin/sh", ["-c", command], { env: httpsEnv });

  assert.equal(existsSync(join(work, "AGENTS.md")), false);
  assert.equal(existsSync(join(work, "docs", "GUIDE.md")), false);
  assert.ok(
    httpsServer.receivedHeaders.some((headers) => headers.authorization === authHeader),
    "prefetch must preserve http.<url>.extraheader despite -c credential.helper=",
  );

  const agents = await execFileAsync("git", ["-C", work, "show", "HEAD:AGENTS.md"], {
    env: { ...httpsEnv, GIT_NO_LAZY_FETCH: "1" },
  });
  assert.equal(agents.stdout, "# Agent rules\nRun focused tests.\n");

  const guide = await execFileAsync("git", ["-C", work, "show", "HEAD:docs/GUIDE.md"], {
    env: { ...httpsEnv, GIT_NO_LAZY_FETCH: "1" },
  });
  assert.equal(guide.stdout, "Subdir guide.\n");

  for (const uncached of ["HEAD:LINK.md", "HEAD:nested/file.txt", "HEAD:README.md"]) {
    await assert.rejects(
      execFileAsync("git", ["-C", work, "show", uncached], {
        env: { ...httpsEnv, GIT_NO_LAZY_FETCH: "1" },
      }),
      uncached,
    );
  }
});

test("blocks protocol.ext.allow and core.fsmonitor overrides in .git/config during prefetch", async () => {
  const extMarker = join(dir, "ext-pwned");
  const fsmonitorMarker = join(dir, "fsmonitor-pwned");
  await git(
    dir,
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    `file://${remote}`,
    work,
  );
  await git(work, "config", "protocol.ext.allow", "always");
  await git(work, "config", "remote.origin.promisor", "true");
  await git(work, "config", "remote.origin.partialclonefilter", "blob:none");
  await git(work, "config", "remote.origin.url", `ext::sh -c touch% ${extMarker}`);
  await git(work, "config", "core.fsmonitor", `touch ${fsmonitorMarker}`);

  const command = buildPrefetchCommand(work, workspace, DEFAULT_PREFETCH_FILES);
  assert.ok(command);
  await execFileAsync("/bin/sh", ["-c", command], { env: ENV });

  assert.equal(existsSync(extMarker), false);
  assert.equal(existsSync(fsmonitorMarker), false);
});

test("skips repos outside the canonical workspace when reached via a symlink", async () => {
  const httpsEnv = { ...ENV, GIT_SSL_NO_VERIFY: "1" };
  const outside = join(dir, "outside");
  const escapedLink = join(workspace, "escaped");
  await execFileAsync(
    "git",
    ["clone", "--quiet", "--filter=blob:none", "--no-checkout", httpsServer.repoUrl, outside],
    { cwd: dir, env: httpsEnv },
  );
  await symlink(outside, escapedLink);

  const command = buildPrefetchCommand(escapedLink, workspace, DEFAULT_PREFETCH_FILES);
  assert.ok(command);
  await execFileAsync("/bin/sh", ["-c", command], { env: httpsEnv });

  await assert.rejects(
    execFileAsync("git", ["-C", outside, "show", "HEAD:AGENTS.md"], {
      env: { ...httpsEnv, GIT_NO_LAZY_FETCH: "1" },
    }),
  );
});

test("exits cleanly on non-partial clones without error", async () => {
  await git(dir, "clone", "--quiet", `file://${remote}`, work);
  const command = buildPrefetchCommand(work, workspace, DEFAULT_PREFETCH_FILES);
  assert.ok(command);
  const result = await execFileAsync("/bin/sh", ["-c", command], { env: ENV });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

async function startHttpsGitServer(projectRoot: string) {
  const keyPath = join(projectRoot, "server-key.pem");
  const certPath = join(projectRoot, "server-cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const receivedHeaders: Array<Readonly<Record<string, string | string[] | undefined>>> = [];
  const server = createServer({ key, cert }, (req, res) => {
    receivedHeaders.push(req.headers);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "https://127.0.0.1");
      const cgiEnv: Record<string, string> = {
        ...ENV,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
      };
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          cgiEnv[`HTTP_${name.toUpperCase().replaceAll("-", "_")}`] = value;
        }
      }
      const child = spawn("git", ["http-backend"], { env: cgiEnv });
      const out: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.on("close", () => {
        const raw = Buffer.concat(out);
        const crlf = raw.indexOf("\r\n\r\n");
        const lf = raw.indexOf("\n\n");
        const sep = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
        const sepLen = sep === crlf ? 4 : 2;
        const headerText = sep === -1 ? "" : raw.subarray(0, sep).toString("utf8");
        const payload = sep === -1 ? raw : raw.subarray(sep + sepLen);
        let statusCode = 200;
        const headers: Record<string, string> = {};
        for (const line of headerText.split(/\r?\n/u)) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const headerName = line.slice(0, colon).trim();
          const headerValue = line.slice(colon + 1).trim();
          if (headerName.toLowerCase() === "status") {
            const parsed = Number.parseInt(headerValue, 10);
            if (!Number.isNaN(parsed)) statusCode = parsed;
          } else {
            headers[headerName] = headerValue;
          }
        }
        res.writeHead(statusCode, headers);
        res.end(payload);
      });
      child.stdin.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `https://127.0.0.1:${port}`;
  return {
    server,
    baseUrl,
    repoUrl: `${baseUrl}/repo.git`,
    receivedHeaders,
  };
}

async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", args, { cwd, env: ENV })).stdout.trim();
}
