import { subscribe } from "node:diagnostics_channel";
import type { Socket } from "node:net";

/** The signals on which srvx closes the server. */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

interface ConnectionMessage {
  readonly socket: Socket;
}

/**
 * Closes the server's connections as soon as none of their requests is in flight once the
 * process is shutting down.
 *
 * On SIGINT or SIGTERM, srvx calls `server.close()` and waits for every connection to end.
 * Node closes only the keep-alive connections that are idle at that moment: one that finishes
 * its response later, or one a client opened without sending a request yet, stays open until
 * the client drops it. Workflow's local queue keeps its connections to this server alive for
 * seconds, so shutdown waited that long.
 */
export default function connectionDrainPlugin(): void {
  /** Each open connection and the number of its requests still in flight. */
  const connections = new Map<Socket, number>();
  let stopping = false;

  subscribe("net.server.socket", (message) => {
    const { socket } = message as ConnectionMessage;
    connections.set(socket, 0);
    socket.once("close", () => connections.delete(socket));
  });
  subscribe("http.server.request.start", (message) => {
    const { socket } = message as ConnectionMessage;
    const inFlight = connections.get(socket);
    if (inFlight !== undefined) connections.set(socket, inFlight + 1);
  });
  subscribe("http.server.response.finish", (message) => {
    const { socket } = message as ConnectionMessage;
    const inFlight = connections.get(socket);
    if (inFlight === undefined) return;
    connections.set(socket, inFlight - 1);
    if (stopping && inFlight === 1) socket.destroySoon();
  });

  const stop = () => {
    stopping = true;
    for (const [socket, inFlight] of connections) {
      if (inFlight === 0) socket.destroy();
    }
  };
  // Registered after srvx's own listeners, so srvx has closed the server when `stop` runs. A
  // signal srvx doesn't handle (it skips graceful shutdown when CI or TEST is set) keeps
  // Node's default.
  setImmediate(() => {
    for (const signal of SHUTDOWN_SIGNALS) {
      if (process.listenerCount(signal) > 0) process.on(signal, stop);
    }
  });
}
