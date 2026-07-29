import { Readable, Writable } from "node:stream";

import { agent, methods, ndJsonStream } from "#compiled/@agentclientprotocol/sdk/index.js";
import { EveAcpAdapter } from "#acp/adapter.js";
import { limitAcpLineBytes } from "#acp/line-limit.js";

export interface RunAcpServerOptions {
  readonly appRoot: string;
  readonly eveVersion: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly validateWorkspaceRoot: boolean;
}

/** Serves one stable ACP v1 connection over process stdio until the client disconnects. */
export async function runAcpServer(options: RunAcpServerOptions): Promise<void> {
  const adapter = new EveAcpAdapter(options);
  const app = agent({ name: "eve" })
    .onRequest(methods.agent.initialize, ({ params }) => adapter.initialize(params))
    .onRequest(methods.agent.session.new, ({ params }) => adapter.newSession(params))
    .onRequest(methods.agent.session.prompt, ({ params, client, signal }) =>
      adapter.prompt(params, client, signal),
    )
    .onRequest(methods.agent.session.close, ({ params }) => adapter.closeSession(params.sessionId))
    .onNotification(methods.agent.session.cancel, ({ params }) => adapter.cancel(params.sessionId));

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>).pipeThrough(
    limitAcpLineBytes(),
  );
  const connection = app.connect(ndJsonStream(output, input));
  const close = () => connection.close();
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    await connection.closed;
  } finally {
    options.signal?.removeEventListener("abort", close);
    await adapter.close();
  }
}
