import { subscribe } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { Server as TlsServer, type TLSSocket } from "node:tls";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

interface ConnectionMessage {
  readonly socket: Socket;
}

interface Connection {
  socket: Socket;
  inFlight: number;
}

function tcpSocket(socket: Socket): Socket {
  return (socket as Socket & { readonly _parent?: Socket | null })._parent ?? socket;
}

function upgraded(socket: Socket): boolean {
  return (socket as Socket & { readonly parser?: unknown }).parser === null;
}

export default function connectionDrainPlugin(): void {
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
