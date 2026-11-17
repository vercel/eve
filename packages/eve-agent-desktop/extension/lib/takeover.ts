import type { TakeoverSource } from "@eve/takeover/core";

import { DESKTOP_ROOT, quoteShellArg, startDesktop, type DesktopSandbox } from "./sandbox";

/** Starting the managed desktop needs eve's `spawn`, which every eve sandbox session has. */
function canSpawn<T extends object>(sandbox: T): sandbox is T & DesktopSandbox {
  return typeof (sandbox as { readonly spawn?: unknown }).spawn === "function";
}

/** Loopback port x11vnc serves the takeover on. */
export const TAKEOVER_VNC_PORT = 5917;

/**
 * The X display over VNC. x11vnc listens on loopback without a VNC password:
 * the takeover proxy's one-use token is the gate, and it bridges the person's
 * WebSocket to this port.
 */
export function vncTakeoverSource(options: {
  readonly display: string;
  readonly manageDesktop: boolean;
  readonly port?: number;
}): TakeoverSource {
  const port = options.port ?? TAKEOVER_VNC_PORT;
  const display = quoteShellArg(options.display);
  return {
    label: "desktop",
    protocol: "rfb",
    upstream: "tcp",
    async prepare(sandbox, signal) {
      if (options.manageDesktop) {
        if (!canSpawn(sandbox)) return { unavailable: "This sandbox can't start the desktop." };
        await startDesktop(sandbox, { display: options.display, signal });
      }
      const started = await sandbox.run({
        signal,
        command: [
          "command -v x11vnc >/dev/null || exit 3",
          `mkdir -p ${DESKTOP_ROOT}`,
          // Probe the port, not the process list: this shell's own command line names x11vnc.
          `{ (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null || x11vnc -display ${display} -rfbport ${port} -localhost -shared -forever -nopw -bg -quiet -o ${DESKTOP_ROOT}/x11vnc.log >/dev/null; }`,
        ].join(" && "),
      });
      if (started.exitCode === 3) {
        return {
          unavailable:
            "x11vnc isn't installed in the sandbox. Install it in prepare with extraPackages: TAKEOVER_APT_PACKAGES.",
        };
      }
      if (started.exitCode !== 0)
        return { unavailable: "The desktop couldn't be shared over VNC." };
      return { portCommand: `echo ${port}` };
    },
    async release(sandbox) {
      // The desktop keeps running for the agent; only the VNC server goes.
      // `[x]11vnc` keeps pkill from matching the shell that runs it.
      await sandbox.run({ command: `pkill -f '[x]11vnc .*-rfbport ${port}' || true` });
    },
  };
}
