#!/usr/bin/env node
import { initialize } from "./init.ts";
import { createHash } from "node:crypto";
import { sleep } from "@eve-start/protocol";
const args = process.argv.slice(2);
const command =
  args.includes("--help") || args.includes("-h")
    ? "help"
    : !args[0] || ["--scope", "--name", "--skip-browser", "--local-only"].includes(args[0])
      ? "init"
      : args[0];
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
async function main() {
  if (["init", "setup", "agent"].includes(command))
    try {
      process.loadEnvFile(".env.local");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  switch (command) {
    case "init":
    case "setup":
      await initialize({
        scope: option("--scope"),
        name: option("--name"),
        skipBrowser: args.includes("--skip-browser"),
        localOnly: args.includes("--local-only"),
      });
      break;
    case "agent": {
      const token = process.env.EVE_START_AGENT_TOKEN,
        url = option("--app") || "http://127.0.0.1:2000";
      if (!token) throw Error("Set EVE_START_AGENT_TOKEN.");
      const wakeToken = createHash("sha256")
        .update("eve-start-wake:" + token)
        .digest("hex");
      let stopped = false;
      process.once("SIGINT", () => {
        stopped = true;
      });
      process.once("SIGTERM", () => {
        stopped = true;
      });
      const target = new URL("/start/tick", url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
        throw Error(
          "The local agent worker only calls localhost. Hosted apps deliver messages automatically.",
        );
      console.log("Checking pending messages in your local eve app at " + target.origin);
      while (!stopped) {
        try {
          const response = await fetch(target, {
            method: "POST",
            headers: { Authorization: "Bearer " + wakeToken },
            redirect: "error",
            signal: AbortSignal.timeout(260000),
          });
          if (!response.ok) throw Error("Local eve app returned " + response.status);
          await response.body?.cancel();
        } catch (error) {
          console.error((error as Error).message);
        }
        await sleep(1000);
      }
      break;
    }
    default:
      console.log(
        "eve Start\n  (no command)  Set up this app: credentials, storage and the cloud browser image\n  init, setup   Aliases for the default command\n  agent         Deliver pending chat messages to a local eve dev server",
      );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
