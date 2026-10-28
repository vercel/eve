import { Drive, Sandbox } from "@vercel/sandbox";
import { createHmac, randomUUID } from "node:crypto";
import type { DB } from "./computer-db.ts";
import assets from "./database-assets.ts";

export type SandboxDatabaseOptions = {
  secret: string;
  log?: (message: string) => void;
  output?: (chunk: string) => void;
};
export const DATABASE_SANDBOX = "eve-start-storage";
export const DATABASE_DRIVE = "eve-start-storage";
const port = 3001;
export async function sandboxDatabase(options: SandboxDatabaseOptions): Promise<DB> {
  if (options.secret.length < 32)
    throw Error(
      "A strong EVE_START_AGENT_TOKEN is required for database access. Run ./scripts/setup.sh.",
    );
  // A separately scoped, 256-bit capability; never the short web password or a mobile credential.
  const secret = createHmac("sha256", options.secret)
    .update("eve-start:database:v1")
    .digest("base64url");
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  let cached: { origin: string; until: number } | undefined;
  let starting: Promise<string> | undefined;
  async function healthy(origin: string) {
    try {
      const response = await fetch(origin + "/health", {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }
  async function start() {
    options.log?.("Preparing the app database…");
    const drive = await Drive.getOrCreate({
      name: DATABASE_DRIVE,
      maxSize: 2 * 1024 ** 3,
      region: "iad1",
    });
    const sandbox = await Sandbox.getOrCreate({
      name: DATABASE_SANDBOX,
      region: "iad1",
      timeout: 3600000,
      ports: [port],
      mounts: { "/data": { drive: drive.name, mode: "read-write" } },
      keepLastSnapshots: { count: 1, expiration: 604800000, deleteEvicted: true },
    });
    if (sandbox.status !== "running") await sandbox.runCommand("true");
    const url = new URL(sandbox.domain(port));
    if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.run"))
      throw Error("Invalid database service address");
    let origin = url.origin;
    if (!(await healthy(origin))) {
      options.log?.("Starting the app database…");
      const stage = "/tmp/eve-storage-init-" + randomUUID();
      await sandbox.runCommand("mkdir", ["-m", "700", stage]);
      try {
        await sandbox.writeFiles([
          ...Object.entries(assets).map(([name, content]) => ({
            path: stage + "/" + name,
            content: Buffer.from(content, "base64"),
            mode: 0o600,
          })),
          {
            path: stage + "/config.json",
            content: Buffer.from(JSON.stringify({ secret })),
            mode: 0o600,
          },
        ]);
        // Close the setup lock in child processes: the detached server has its own lifetime lock.
        const command = await sandbox.runCommand({
          cmd: "flock",
          args: [
            "--close",
            "-w",
            "120",
            "/tmp/eve-start-storage-setup.lock",
            "bash",
            stage + "/setup.sh",
            stage,
          ],
          detached: true,
        });
        if (options.output) for await (const line of command.logs()) options.output(line.data);
        const done = await command.wait();
        if (done.exitCode !== 0)
          throw Error("Database setup failed: " + (await done.stderr()).slice(-1000));
      } finally {
        await sandbox.runCommand("rm", ["-rf", stage]).catch(() => {});
      }
      origin = new URL(sandbox.domain(port)).origin;
      if (!(await healthy(origin)))
        throw Error("The app database did not become ready. Run ./scripts/setup.sh.");
    }
    cached = {
      origin,
      until: Math.min(Date.now() + 15000, (sandbox.expiresAt?.getTime() ?? Infinity) - 5000),
    };
    return origin;
  }
  async function origin() {
    if (cached && Date.now() < cached.until) return cached.origin;
    starting ||= start().finally(() => {
      starting = undefined;
    });
    return starting;
  }
  await origin();
  return {
    async query<T>(query: string, args: (string | number | null)[] = []) {
      const address = await origin();
      let response: Response;
      try {
        response = await fetch(address + "/query", {
          method: "POST",
          headers,
          body: JSON.stringify({ query, args }),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        cached = undefined;
        throw Error(
          "The database connection was interrupted. The query may have committed and has not been automatically repeated.",
        );
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        cached = undefined;
        throw Error(
          "The database service is unavailable. The query has not been automatically repeated.",
        );
      }
      const result = (await response.json()) as { rows: T[]; error?: string; code?: string };
      if (!response.ok)
        throw Object.assign(Error(result.error || "Database request failed"), {
          code: result.code,
        });
      return result.rows;
    },
    async close() {},
  };
}
