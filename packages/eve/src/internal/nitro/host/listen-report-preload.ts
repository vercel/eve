import { tracingChannel } from "node:diagnostics_channel";
import type { Server } from "node:net";

/** What the built server reports to `eve start` about each `listen()`. */
export type ListenReport =
  | { readonly type: "listening"; readonly address: string; readonly port: number }
  | {
      readonly type: "listen-error";
      readonly code: string | undefined;
      readonly port: number | undefined;
    };

function report(message: ListenReport): void {
  process.send?.(message);
}

// `eve start` loads this with `--import` so the built server reports its own
// bind result, which nothing else on the port can fake.
process.channel?.unref();

tracingChannel<unknown, { server?: Server; error?: NodeJS.ErrnoException & { port?: number } }>(
  "net.server.listen",
).subscribe({
  start() {},
  end() {},
  asyncStart() {},
  asyncEnd({ server }) {
    const address = server?.address();
    if (address !== null && typeof address === "object") {
      report({ type: "listening", address: address.address, port: address.port });
    }
  },
  error({ error }) {
    report({ type: "listen-error", code: error?.code, port: error?.port });
  },
});
