import { Sandbox, Drive } from "@vercel/sandbox";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserCommand } from "@eve-start/protocol";
import type { DB } from "../../server/db.ts";
const runtimeFiles = [
  "package.json",
  "install.sh",
  "start.sh",
  "runner.mjs",
  "chrome.mjs",
  "access.mjs",
  "daemon.mjs",
  "ctl.mjs",
  "index.html",
  "eve-logo.svg",
  "favicon.svg",
  "geist.woff2",
  "geist-mono.woff2",
];
const dir = "/tmp/eve";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = {
  agent_id: string;
  sandbox_name: string;
  drive_name: string;
  state: string;
  lease_until: number;
  error: string | null;
};
export class DesktopManager {
  private db: DB;
  private options: {
    origin?: string;
    secret?: string;
    assets?: Record<string, string>;
  };
  constructor(
    db: DB,
    options: {
      origin?: string;
      secret?: string;
      assets?: Record<string, string>;
    } = {},
  ) {
    this.db = db;
    this.options = options;
  }
  private async runtime(name: string) {
    return this.options.assets?.[name]
      ? Buffer.from(this.options.assets[name], "base64")
      : readFile(
          new URL(
            name === "protocol.mjs" ? "../../../protocol/dist/index.js" : `../runtime/${name}`,
            import.meta.url,
          ),
        );
  }
  names(agentId: string) {
    const suffix = agentId.replaceAll("-", "").slice(0, 20);
    return { sandbox: `eve-desktop-${suffix}`, drive: `eve-profile-${suffix}` };
  }
  async status(agentId: string) {
    const [row] = await this.db.query<Row>("SELECT * FROM remote_desktops WHERE agent_id=$1", [
      agentId,
    ]);
    return row
      ? {
          state: row.state,
          sandboxName: row.sandbox_name,
          driveName: row.drive_name,
          error: row.error,
        }
      : { state: "stopped" };
  }
  async ensure(agentId: string) {
    const names = this.names(agentId),
      time = Date.now();
    await this.db.query(
      "INSERT INTO remote_desktops(agent_id,sandbox_name,drive_name,state) VALUES($1,$2,$3,'stopped') ON CONFLICT(agent_id) DO NOTHING",
      [agentId, names.sandbox, names.drive],
    );
    const lease = await this.db.query(
      "UPDATE remote_desktops SET lease_until=$1 WHERE agent_id=$2 AND lease_until<$3 RETURNING agent_id",
      [time + 300000, agentId, time],
    );
    if (!lease.length) return this.status(agentId);
    try {
      const drive = await Drive.getOrCreate({
        name: names.drive,
        maxSize: 2 * 1024 ** 3,
        region: "iad1",
      });
      if (drive.currentSandboxName && drive.currentSandboxName !== names.sandbox)
        throw new Error("Profile Drive is already in use by another sandbox");
      const [prepared] = await this.db.query<{ value: string }>(
        "SELECT value FROM agent_state WHERE agent_id=$1 AND key='browser.image'",
        [agentId],
      );
      const image = prepared ? JSON.parse(prepared.value) : undefined;
      const sandboxOptions = {
        name: names.sandbox,
        resources: { vcpus: 2 },
        timeout: 3600000,
        ports: [6080],
        mounts: { "/data": { drive: drive.name, mode: "read-write" as const } },
        region: "iad1" as const,
        keepLastSnapshots: { count: 1, expiration: 604800000, deleteEvicted: true },
      };
      let sb: Sandbox;
      try {
        sb = await Sandbox.get({ name: names.sandbox, resume: false });
      } catch (error) {
        if ((error as { response?: Response }).response?.status !== 404) throw error;
        sb = await Sandbox.getOrCreate(
          image?.snapshotId
            ? {
                ...sandboxOptions,
                source: { type: "snapshot", snapshotId: String(image.snapshotId) },
              }
            : sandboxOptions,
        );
      }
      if (sb.keepLastSnapshots?.count !== 1)
        await sb.update({
          keepLastSnapshots: { count: 1, expiration: 604800000, deleteEvicted: true },
        });
      const probeHealth = () =>
        sb.runCommand("node", [
          "-e",
          "fetch('http://127.0.0.1:6080/health',{signal:AbortSignal.timeout(2000)}).then(async r=>process.exit(r.ok?0:(await r.json()).recovering?2:1)).catch(()=>process.exit(1))",
        ]);
      let health = await probeHealth();
      // Covers the uploaded runtime so any change reinstalls it, but excludes the dashboard
      // origin: local dev and the deployment share this desktop and must not restart each other.
      const expectedVersion =
        "14:" + hash(JSON.stringify([this.commandKey(agentId), this.options.assets ?? null]));
      const version = await sb.readFileToBuffer({ path: `${dir}/version` });
      if (health.exitCode === 2) {
        for (let i = 0; i < 45 && health.exitCode === 2; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          health = await probeHealth();
        }
        if (health.exitCode !== 0)
          throw new Error("Cloud Chrome is reconnecting. Try again shortly.");
      }
      if (health.exitCode !== 0 || version?.toString() !== expectedVersion) {
        if (health.exitCode === 0) {
          const [active] = await this.db.query(
            "SELECT agent_id AS id FROM jobs WHERE agent_id=$1 AND state='running' AND expires>$2 LIMIT 1",
            [agentId, Date.now()],
          );
          if (active) return this.status(agentId);
          await sb.runCommand("node", [
            "-e",
            "fetch('http://127.0.0.1:9222/json/list').then(r=>r.json()).then(p=>require('node:fs').writeFileSync('/data/eve-open-tabs.json',JSON.stringify(p.filter(t=>t.type==='page'&&/^https?:/.test(t.url)).map(t=>t.url)),{mode:384})).catch(()=>{})",
          ]);
          await sb.runCommand("node", [`${dir}/ctl.mjs`, "stop"]);
          await sb.runCommand("flock", ["-w", "15", "/tmp/eve-desktop.lock", "true"]);
        }
        await this.db.query(
          "UPDATE remote_desktops SET state='starting',error=NULL WHERE agent_id=$1",
          [agentId],
        );
        const folder = await sb.runCommand("mkdir", ["-p", dir]);
        if (folder.exitCode !== 0) throw new Error("Could not prepare desktop runtime directory");
        const files = await Promise.all(
          runtimeFiles.map(async (name) => ({
            path: `${dir}/${name}`,
            content: await this.runtime(name),
          })),
        );
        files.push({ path: `${dir}/protocol.mjs`, content: await this.runtime("protocol.mjs") });
        files.push({ path: `${dir}/version`, content: Buffer.from(expectedVersion) });
        await sb.writeFiles(files);
        const config = {
          agentId,
          controlKey: randomBytes(32).toString("base64url"),
          commandKey: this.commandKey(agentId),
          publicOrigin: sb.domain(6080),
        };
        await sb.writeFiles([
          { path: `${dir}/config.json`, content: Buffer.from(JSON.stringify(config)), mode: 0o600 },
        ]);
        const install = await sb.runCommand("bash", [`${dir}/install.sh`]);
        if (install.exitCode !== 0)
          throw new Error(`Desktop installation failed: ${(await install.stderr()).slice(-1000)}`);
        await sb.runCommand({ cmd: "bash", args: [`${dir}/start.sh`], detached: true });
        let ready = false;
        for (let i = 0; i < 90; i++) {
          const probe = await sb.runCommand("node", [
            "-e",
            "fetch('http://127.0.0.1:6080/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ]);
          if (probe.exitCode === 0) {
            ready = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!ready) throw new Error("Desktop did not become ready");
      }
      await this.db.query(
        "INSERT INTO agent_state(agent_id,key,value) VALUES($1,'desktop.direct',$2) ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value",
        [agentId, JSON.stringify({ origin: sb.domain(6080), version: 12 })],
      );
      await this.db.query("UPDATE remote_desktops SET state='ready',error=NULL WHERE agent_id=$1", [
        agentId,
      ]);
      return this.status(agentId);
    } catch (error) {
      await this.db.query("UPDATE remote_desktops SET state='error',error=$1 WHERE agent_id=$2", [
        (error as Error).message.slice(0, 1200),
        agentId,
      ]);
      throw error;
    } finally {
      await this.db.query("UPDATE remote_desktops SET lease_until=0 WHERE agent_id=$1", [agentId]);
    }
  }
  private healthCache = new Map<string, { until: number; value: Promise<boolean> }>();
  /** The address of a desktop that has finished starting, validated before any request. */
  private async address(agentId: string) {
    const [row] = await this.db.query<{ value: string }>(
      "SELECT value FROM agent_state WHERE agent_id=$1 AND key='desktop.direct'",
      [agentId],
    );
    if (!row) return undefined;
    const origin = new URL(JSON.parse(row.value).origin);
    if (
      origin.protocol !== "https:" ||
      !origin.hostname.endsWith(".vercel.run") ||
      origin.pathname !== "/"
    )
      throw new Error("Invalid cloud browser address");
    return origin;
  }
  /** The app probes the desktop directly, so a laptop dev server needs no inbound connection. */
  private async probe(agentId: string) {
    const origin = await this.address(agentId);
    if (!origin) return false;
    try {
      const response = await fetch(new URL("/health", origin), {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }
  /** Status polling reads a short-lived cache rather than probing the Sandbox on every request. */
  healthy(agentId: string) {
    const cached = this.healthCache.get(agentId);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = this.status(agentId).then((s) => s.state === "ready" && this.probe(agentId));
    this.healthCache.set(agentId, { until: Date.now() + 5000, value });
    return value;
  }
  async ready(agentId: string) {
    await this.ensure(agentId);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await this.probe(agentId)) {
        this.healthCache.set(agentId, { until: Date.now() + 5000, value: Promise.resolve(true) });
        return;
      }
      const state = await this.status(agentId);
      if (state.state === "error") throw new Error(state.error || "Cloud browser startup failed");
      if (state.state !== "ready" && state.state !== "starting") await this.ensure(agentId);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Cloud browser did not become ready in time");
  }
  private async ticket(agentId: string, dashboard?: string) {
    const sb = await Sandbox.get({ name: this.names(agentId).sandbox });
    const command = await sb.runCommand("node", [
      `${dir}/ctl.mjs`,
      "ticket",
      ...(dashboard ? [new URL(dashboard).origin] : []),
    ]);
    if (command.exitCode !== 0) throw new Error("Could not issue a desktop ticket");
    const { ticket } = JSON.parse(await command.stdout());
    return { sb, ticket: ticket as string };
  }
  async link(agentId: string) {
    const state = await this.ensure(agentId);
    if (state.state !== "ready") return state;
    const { sb, ticket } = await this.ticket(agentId);
    return { ...state, url: `${sb.domain(6080)}/session?ticket=${encodeURIComponent(ticket)}` };
  }
  private commandKey(agentId: string) {
    const key = this.options.secret || process.env.EVE_ADMIN_TOKEN;
    if (!key || key.length < 24)
      throw new Error("EVE_ADMIN_TOKEN is required for scoped browser access");
    return createHmac("sha256", key).update(`eve-browser:${agentId}`).digest("base64url");
  }
  async execute(agentId: string, command: BrowserCommand): Promise<{ result: unknown }> {
    const origin = await this.address(agentId);
    if (!origin) throw new Error("Cloud browser is not ready");
    const response = await fetch(new URL("/agent/execute", origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.commandKey(agentId)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(80_000),
    });
    const data = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(data.error || `Cloud browser returned ${response.status}`);
    return { result: data.result };
  }
  async stream(agentId: string) {
    const state = await this.ensure(agentId);
    if (state.state !== "ready") return state;
    const { sb, ticket } = await this.ticket(agentId, this.options.origin);
    return {
      url: `${sb.domain(6080).replace("https:", "wss:")}/websockify?ticket=${encodeURIComponent(ticket)}`,
      expiresIn: 300,
    };
  }
  async stop(agentId: string) {
    this.healthCache.delete(agentId);
    const sb = await Sandbox.get({ name: this.names(agentId).sandbox, resume: false });
    if (sb.status === "running") {
      await sb.runCommand("node", [`${dir}/ctl.mjs`, "stop"]).catch(() => {});
      await sb.stop();
    }
    await this.db.query(
      "UPDATE remote_desktops SET state='stopped',lease_until=0 WHERE agent_id=$1",
      [agentId],
    );
    return { state: "stopped", profileRetained: true };
  }
}
