import { subscribe } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { Server as TlsServer, type TLSSocket } from "node:tls";

/** The signals on which srvx closes the server. */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

interface ConnectionMessage {
  readonly socket: Socket;
}

/** An open connection, keyed by its TCP socket. */
interface Connection {
  /** The socket HTTP reads: the TCP socket, or the `TLSSocket` that wraps it. */
  socket: Socket;
  /** The number of its requests still in flight. */
  inFlight: number;
}

/**
 * The TCP socket under a request's socket. Under HTTPS, `net.server.socket` reports the TCP
 * socket while the request channels report the `TLSSocket`, whose `_parent` is that TCP socket.
 */
function tcpSocket(socket: Socket): Socket {
  return (socket as Socket & { readonly _parent?: Socket | null })._parent ?? socket;
}

/**
 * Whether a connection was upgraded, to a WebSocket for example. Node frees the HTTP parser of
 * an upgraded socket, which no `http.server.request.start` reports.
 */
function upgraded(socket: Socket): boolean {
  return (socket as Socket & { readonly parser?: unknown }).parser === null;
}

/**
 * Closes the server's connections as soon as none of their requests is in flight once the
 * process is shutting down.
 *
 * On SIGINT or SIGTERM, srvx calls `server.close()` and waits for every connection to end.
 * Node closes only the keep-alive connections that are idle at that moment: one that finishes
 * its response later, or one a client opened without sending a request yet, stays open until
 * the client drops it. Workflow's local queue keeps its connections to this server alive for
 * seconds, so shutdown waited that long. An upgraded connection stays open as before, until
 * its client closes it or the process exits.
 */
export default function connectionDrainPlugin(): void {
  // srvx skips graceful shutdown when CI or TEST is set. A signal then keeps Node's default,
  // which a listener here would cancel.
  if (process.env.CI || process.env.TEST) return;

  const connections = new Map<Socket, Connection>();
  const tlsServers = new WeakSet<TlsServer>();
  let stopping = false;

  subscribe("net.server.socket", (message) => {
    const { socket } = message as ConnectionMessage;
    connections.set(socket, { socket, inFlight: 0 });
    socket.once("close", () => connections.delete(socket));
    const { server } = socket as Socket & { readonly server?: unknown };
    if (server instanceof TlsServer && !tlsServers.has(server)) {
      tlsServers.add(server);
      server.on("secureConnection", (tlsSocket: TLSSocket) => {
        const connection = connections.get(tcpSocket(tlsSocket));
        if (connection !== undefined) connection.socket = tlsSocket;
      });
    }
  });
  subscribe("http.server.request.start", (message) => {
    const { socket } = message as ConnectionMessage;
    const connection = connections.get(tcpSocket(socket));
    if (connection !== undefined) connection.inFlight += 1;
  });
  subscribe("http.server.response.finish", (message) => {
    const { socket } = message as ConnectionMessage;
    const connection = connections.get(tcpSocket(socket));
    if (connection === undefined) return;
    connection.inFlight -= 1;
    if (stopping && connection.inFlight === 0) socket.destroySoon();
  });

  const stop = () => {
    stopping = true;
    for (const { socket, inFlight } of connections.values()) {
      if (inFlight === 0 && !upgraded(socket)) socket.destroy();
    }
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, stop);
}
