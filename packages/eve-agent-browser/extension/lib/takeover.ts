import type { TakeoverSource } from "@eve/takeover/core";

import { quoteShellArg } from "./shared.js";

/** Prints the session's stream port, or fails when it isn't streaming. */
const PRINT_PORT = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s).data;if(d&&d.enabled&&d.connected&&d.port){console.log(d.port);return}}catch{}process.exit(1)})'`;

/**
 * agent-browser's own viewport stream: JPEG frames out, CDP-style input in,
 * from a WebSocket server that listens on loopback.
 */
export function agentBrowserTakeoverSource(options: {
  readonly binary: string;
  readonly session: string;
}): TakeoverSource {
  const status = `${quoteShellArg(options.binary)} --session ${quoteShellArg(options.session)} --json stream status`;
  const portCommand = `${status} | ${PRINT_PORT}`;
  return {
    label: "browser",
    protocol: "screencast",
    upstream: "websocket",
    async prepare(sandbox, signal) {
      const probe = await sandbox.run({ command: portCommand, signal });
      return probe.exitCode === 0
        ? { portCommand }
        : { unavailable: "No browser page is open. Open the page that needs the person first." };
    },
  };
}
