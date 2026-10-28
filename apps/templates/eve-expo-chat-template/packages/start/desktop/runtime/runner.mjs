import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { access, chmod } from "node:fs/promises";
const commands = new Set([
  "open",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "drag",
  "scroll",
  "scrollintoview",
  "get",
  "find",
  "screenshot",
  "console",
  "errors",
  "network",
  "tab",
  "close",
  "read",
  "wait",
  "upload",
  "eval",
]);
const forbidden = new Set([
  "--cdp",
  "--auto-connect",
  "--profile",
  "--provider",
  "--executable-path",
  "--args",
  "--extension",
  "--proxy",
  "--auth-header",
  "--state",
  "--config",
]);
export function browserArgs(args, session) {
  const clean = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") throw Error("Browser arguments must be strings");
    if (arg === "--session") {
      i++;
      continue;
    }
    if (forbidden.has(arg) || [...forbidden].some((flag) => arg.startsWith(flag + "=")))
      throw Error("Browser connection settings are controlled by the selected runner");
    clean.push(arg);
  }
  if (!commands.has(clean[0])) throw Error("Only the official browser tool commands are supported");
  if (!clean.includes("--json")) clean.push("--json");
  return ["--session", session, ...clean];
}
export class AgentBrowserRunner {
  native;
  options;
  constructor(options = {}) {
    this.options = options;
  }
  async prepare() {
    if (this.options.binary) {
      this.native = this.options.binary;
      return;
    }
    const require = createRequire(import.meta.url);
    const launcher = require.resolve("agent-browser/bin/agent-browser.js");
    const root = dirname(dirname(launcher));
    const os =
      process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime
        ? "linux-musl"
        : process.platform;
    const arch = process.platform === "win32" && process.arch === "arm64" ? "x64" : process.arch;
    this.native = join(
      root,
      "bin",
      `agent-browser-${os}-${arch}${process.platform === "win32" ? ".exe" : ""}`,
    );
    try {
      await access(this.native);
    } catch {
      const result = await this.run(
        process.execPath,
        [join(root, "scripts/postinstall.js")],
        120000,
      );
      if (result.exitCode !== 0)
        throw Error(`Could not install agent-browser: ${result.stderr.slice(-1000)}`);
      await access(this.native);
    }
    if (process.platform !== "win32") await chmod(this.native, 0o755);
  }
  async execute(command) {
    if (command.type !== "agent-browser")
      throw Error("This runner accepts agent-browser commands only. Update your client.");
    if (!this.native) await this.prepare();
    const connection = this.options.cdp ? ["--cdp", this.options.cdp] : ["--auto-connect"];
    return this.run(
      this.native,
      [...connection, ...browserArgs(command.args, this.options.session || "eve-go")],
      75000,
    );
  }
  async detach() {
    if (!this.native) await this.prepare();
    return this.run(
      this.native,
      ["--session", this.options.session || "eve-go", "close", "--json"],
      5000,
    );
  }
  async ready() {
    try {
      const r = await this.execute({ type: "agent-browser", args: ["tab", "--json"] });
      return r.exitCode === 0 && JSON.parse(r.stdout).success !== false;
    } catch {
      return false;
    }
  }
  run(binary, args, timeout) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENT_BROWSER_AUTO_CONNECT: this.options.cdp ? "0" : "1" },
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let stdout = "",
        stderr = "",
        settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        if (!settled) {
          settled = true;
          reject(
            Error(
              "Browser command timed out; its outcome may be unknown. Inspect the browser before retrying.",
            ),
          );
        }
      }, timeout);
      child.stdout.on("data", (data) => {
        stdout += data;
        if (stdout.length > 4 * 1024 * 1024) child.kill("SIGTERM");
      });
      child.stderr.on("data", (data) => (stderr += data));
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ exitCode: code ?? 1, stdout, stderr });
        }
      });
    });
  }
}
