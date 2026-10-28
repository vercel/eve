import { Sandbox, Snapshot } from "@vercel/sandbox";
import { createHash, randomUUID } from "node:crypto";
import { database } from "./computer-db.ts";
import assets from "./computer-assets.ts";
import type { SandboxDatabaseOptions } from "./sandbox-database.ts";

export async function prepareAppDatabase(options: SandboxDatabaseOptions) {
  const db = await database({ url: "", kind: "app", sandbox: options });
  try {
    await db.query("SELECT 1");
    options.log?.("App database ready.");
  } finally {
    await db.close();
  }
}
export async function prepareBrowserImage(options: {
  agentId: string;
  databaseUrl?: string;
  agentToken?: string;
  sqlitePath?: string;
  log?: (message: string) => void;
  output?: (chunk: string) => void;
}) {
  const db = await database({
    url: options.databaseUrl || "",
    path: options.sqlitePath || ".eve/computer.sqlite",
    kind: "app",
    sandbox:
      !options.databaseUrl && options.agentToken
        ? { secret: options.agentToken, log: options.log, output: options.output }
        : undefined,
  });
  const key = createHash("sha256")
    .update(assets["package.json"]!)
    .update(assets["install.sh"]!)
    .digest("hex");
  try {
    const [cached] = await db.query<{ value: string }>(
      "SELECT value FROM agent_state WHERE agent_id=$1 AND key='browser.image'",
      [options.agentId],
    );
    if (cached) {
      const image = JSON.parse(cached.value);
      if (image.key === key) {
        try {
          await Snapshot.get({ snapshotId: image.snapshotId });
          options.log?.("Browser image is already prepared.");
          return image;
        } catch (error) {
          if ((error as { response?: Response }).response?.status !== 404) throw error;
        }
      }
    }
    options.log?.("Preparing a clean browser image in this Vercel project…");
    const sandbox = await Sandbox.create({
      name: "eve-image-" + randomUUID().slice(0, 12),
      resources: { vcpus: 2 },
      timeout: 600000,
      region: "iad1",
    });
    try {
      await sandbox.runCommand("mkdir", ["-p", "/tmp/eve"]);
      await sandbox.writeFiles(
        (["package.json", "install.sh"] as const).map((name) => ({
          path: "/tmp/eve/" + name,
          content: Buffer.from(assets[name]!, "base64"),
        })),
      );
      options.log?.("Installing Chrome and browser dependencies…");
      const command = await sandbox.runCommand({
        cmd: "bash",
        args: ["/tmp/eve/install.sh"],
        detached: true,
      });
      if (options.output) for await (const line of command.logs()) options.output(line.data);
      const install = await command.wait();
      if (install.exitCode !== 0)
        throw Error("Browser image installation failed: " + (await install.stderr()).slice(-600));
      options.log?.("Checking the browser image…");
      const check = await sandbox.runCommand("bash", [
        "-c",
        'google-chrome --version && command -v Xvfb && command -v x11vnc && test ! -e /tmp/eve/config.json && test -z "$(ls -A /data/chrome-profile)"',
      ]);
      if (check.exitCode !== 0) throw Error("Browser image validation failed");
      options.log?.("Saving the browser image…");
      const snapshot = await sandbox.snapshot({ expiration: 0 }),
        image = { snapshotId: snapshot.snapshotId, key };
      await db.query(
        "INSERT INTO agent_state(agent_id,key,value) VALUES($1,'browser.image',$2) ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value",
        [options.agentId, JSON.stringify(image)],
      );
      options.log?.("Clean browser image prepared. Cookies remain on the separate profile Drive.");
      return image;
    } finally {
      await sandbox.stop().catch(() => {});
    }
  } finally {
    await db.close();
  }
}
