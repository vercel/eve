import { Readable, Writable } from "node:stream";

import { agent, methods, ndJsonStream } from "#compiled/@agentclientprotocol/sdk/index.js";
import { EveAcpAdapter, type EveAcpAdapterOptions } from "#acp/adapter.js";
import type { ClientOptions } from "#client/types.js";
import { limitAcpLineBytes } from "#acp/line-limit.js";

/** Configuration for one ACP stdio connection backed by an eve server. */
export interface RunAcpServerOptions {
  readonly auth?: ClientOptions["auth"];
  readonly eveVersion: string;
  readonly headers?: ClientOptions["headers"];
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  /** Local workspace root to enforce; omit when connecting to a remote deployment. */
  readonly workspaceRoot?: string;
  /** @internal Test seam for the public eve client boundary. */
  readonly client?: EveAcpAdapterOptions["client"];
}

/** Node streams for one ACP stdio connection. */
export interface AcpServerStreams {
  readonly input: Readable;
  readonly output: Writable;
}

/** Serves one stable ACP v1 connection over process stdio until the client disconnects. */
export async function runAcpServer(options: RunAcpServerOptions): Promise<void> {
  await runAcpServerOnStreams(options, { input: process.stdin, output: process.stdout });
}

/** Serves one stable ACP v1 connection over the supplied Node streams. */
export async function runAcpServerOnStreams(
  options: RunAcpServerOptions,
  streams: AcpServerStreams,
): Promise<void> {
  const adapter = new EveAcpAdapter(options);
  const app = agent({ name: "eve" })
    .onRequest(methods.agent.initialize, ({ params }) => adapter.initialize(params))
    .onRequest(methods.agent.session.new, ({ params }) => adapter.newSession(params))
    .onRequest(methods.agent.session.prompt, ({ params, client, signal }) =>
      adapter.prompt(params, client, signal),
    )
    .onRequest(methods.agent.session.close, ({ params }) => adapter.closeSession(params.sessionId))
    .onNotification(methods.agent.session.cancel, ({ params }) => adapter.cancel(params.sessionId));

  const output = Writable.toWeb(streams.output) as WritableStream<Uint8Array>;
  const input = (Readable.toWeb(streams.input) as ReadableStream<Uint8Array>).pipeThrough(
    limitAcpLineBytes(),
  );
  const connection = app.connect(ndJsonStream(output, input));
  const close = () => connection.close();
  if (options.signal?.aborted) {
    close();
  } else {
    options.signal?.addEventListener("abort", close, { once: true });
  }
  try {
    await connection.closed;
  } finally {
    options.signal?.removeEventListener("abort", close);
    await adapter.close();
  }
}
