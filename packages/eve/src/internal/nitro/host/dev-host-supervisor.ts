import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { RunnerManager } from "#compiled/env-runner/index.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { EveDevRunner } from "#internal/nitro/host/dev-runner.js";
import {
  closeServer,
  createPublicRequest,
  writeRequestError,
  writeResponse,
} from "#internal/nitro/host/dev-server-http.js";
import { toErrorMessage } from "#shared/errors.js";

const RUNNER_READY_TIMEOUT_MS = 60_000;
/** Matches a worker's own graceful budget; the CLI's close budget covers it. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** One built host: a worker entry plus the workspace its workers read. */
export interface DevHost {
  /** Removes the host's workspace once no worker started from it is left. */
  readonly dispose?: () => Promise<void>;
  readonly entry: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

/** The part of the supervisor the rebuild coordinator drives. */
export interface DevHostSwitch {
  /** Boots a spare worker from the current host for the next {@link recycle}. */
  prepareSpare(): void;
  /**
   * Moves to a fresh worker on the current host. Node never unloads a module,
   * so a worker keeps every generation it imported; a fresh one loads only
   * the active generation.
   */
  recycle(): Promise<void>;
  /**
   * Moves to a ready worker started from `host`. Rejects, and leaves the
   * current worker serving, when the candidate fails readiness.
   */
  swapTo(host: DevHost): Promise<void>;
}

export interface DevServerListener {
  close(): Promise<void>;
  readonly node: { readonly server: Server };
  ready(): Promise<void>;
  readonly url: string | undefined;
}

interface HostRecord {
  readonly host: DevHost;
  disposal: Promise<void> | undefined;
  /** Workers started from this host that have not terminated yet. */
  workers: number;
}

interface Worker {
  readonly record: HostRecord;
  /** Settles after the worker terminated and its host was released. */
  readonly released: Promise<void>;
  readonly runner: EveDevRunner;
}

interface Spare {
  readonly ready: Promise<boolean>;
  readonly worker: Worker;
}

interface DevServerLogger {
  error(message: unknown, ...details: unknown[]): unknown;
}

/**
 * eve's development server: it answers parent-owned control routes, and
 * forwards everything else to one worker through env-runner's
 * `RunnerManager`. A swap waits for the candidate to be ready, and the
 * retired worker keeps serving the requests and WebSockets it already
 * admitted, however long a streaming turn takes, before it shuts down.
 */
export class DevHostSupervisor implements DevHostSwitch {
  readonly #disposals = new Set<Promise<void>>();
  readonly #listeners = new Set<{ beginClose(): Promise<void>; destroySockets(): void }>();
  readonly #logger: DevServerLogger;
  readonly #manager = new RunnerManager();
  readonly #workers = new Set<Worker>();
  #active: Worker | undefined;
  /** Settles when a worker becomes active or the server closes; created on demand. */
  #activeChange: PromiseWithResolvers<void> | undefined;
  #candidate: Worker | undefined;
  #chain: Promise<void> = Promise.resolve();
  #clientAddressSecret: string | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #controlHandler: ((request: Request) => Promise<Response | undefined>) | undefined;
  /** Host of the active worker; its workspace stays until another host replaces it. */
  #current: HostRecord | undefined;
  #spare: Spare | undefined;
  #workerCount = 0;

  constructor(logger: DevServerLogger = console) {
    this.#logger = logger;
    // Fires only for the attached worker closing on its own.
    this.#manager.onClose(() => this.#restartAfterCrash());
  }

  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void {
    this.#controlHandler = handler;
  }

  /**
   * Enables signed client-address metadata on forwarded requests. Without it
   * a worker only sees the parent's loopback hop as the peer address.
   */
  setClientAddressSecret(secret: string): void {
    this.#clientAddressSecret = secret;
  }

  swapTo(host: DevHost): Promise<void> {
    return this.#enqueue(
      async () => await this.#swap({ disposal: undefined, host, workers: 0 }, false),
    );
  }

  recycle(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#current === undefined) {
        throw new Error("Development server has no worker to recycle.");
      }
      await this.#swap(this.#current, true);
    });
  }

  prepareSpare(): void {
    const record = this.#current;
    const spare = this.#spare;
    if (
      this.#closed ||
      record === undefined ||
      (spare?.worker.record === record && !spare.worker.runner.closed)
    ) {
      return;
    }
    this.#discardSpare();
    const worker = this.#start(record);
    const next: Spare = {
      // A spare that closes or fails readiness is never ready, so a recycle
      // waiting on it starts its own worker instead of waiting out the timeout.
      ready: worker.runner.waitForReady(RUNNER_READY_TIMEOUT_MS).then(
        () => true,
        () => {
          if (this.#spare === next) this.#discardSpare();
          return false;
        },
      ),
      worker,
    };
    this.#spare = next;
  }

  listen(input: { readonly hostname: string; readonly port: number }): DevServerListener {
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }

    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket as Socket, head);
    });

    let url: string | undefined;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectPromise(new Error("Development server did not expose a TCP address."));
          return;
        }
        const host = input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname;
        url = `http://${host}:${String(address.port)}/`;
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: input.hostname, port: input.port });
    });

    let closePromise: Promise<void> | undefined;
    const listener = {
      beginClose: () => {
        closePromise ??= closeServer(server).finally(() => this.#listeners.delete(listener));
        return closePromise;
      },
      destroySockets: () => {
        for (const socket of sockets) socket.destroy();
      },
    };
    this.#listeners.add(listener);

    return {
      async close() {
        const closed = listener.beginClose();
        listener.destroySockets();
        await closed;
      },
      node: { server },
      ready: async () => await ready,
      get url() {
        return url;
      },
    };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#wakeActiveWaiters();

    // A candidate mid-readiness or a booting spare a recycle waits on would
    // hold the swap queue until the readiness timeout.
    const closing = new Error("Development server is closing.");
    await Promise.all(
      [this.#candidate, this.#spare?.worker].map(async (worker) => {
        await worker?.runner.close(closing);
      }),
    );
    await this.#chain;

    const listeners = [...this.#listeners];
    const listenersClosed = listeners.map((listener) => listener.beginClose());
    // Dropping client sockets aborts their proxied requests, so the workers'
    // graceful shutdown does not wait out open streams.
    for (const listener of listeners) listener.destroySockets();

    const current = this.#current;
    this.#active = undefined;
    this.#current = undefined;
    this.#discardSpare();
    await this.#manager.shutdown(SHUTDOWN_TIMEOUT_MS);
    await Promise.all([...this.#workers].map(async (worker) => await worker.released));
    // A host whose last worker crashed and failed to restart has no worker left to release it.
    if (current !== undefined && current.workers === 0) this.#dispose(current);
    await Promise.all(this.#disposals);
    await Promise.all(listenersClosed);
  }

  #enqueue(swap: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(swap);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #swap(record: HostRecord, useSpare: boolean): Promise<void> {
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }

    let worker = useSpare ? await this.#takeSpare(record) : undefined;
    if (this.#closed) {
      await worker?.runner.close(new Error("Development server is closing."));
      throw new Error("Development server is closed.");
    }
    if (worker === undefined) {
      worker = this.#start(record);
      this.#candidate = worker;
      try {
        await worker.runner.waitForReady(RUNNER_READY_TIMEOUT_MS);
      } catch (error) {
        await worker.runner.close(error);
        // A candidate host that never served disposes its workspace here.
        await worker.released;
        throw new Error(`Development worker failed before readiness: ${toErrorMessage(error)}`, {
          cause: error,
        });
      } finally {
        this.#candidate = undefined;
      }
    }

    if (this.#closed) {
      await worker.runner.close(new Error("Development server is closing."));
      throw new Error("Development server closed before the worker was ready.");
    }

    const previous = this.#current;
    this.#active = worker;
    this.#current = record;
    if (this.#spare !== undefined && this.#spare.worker.record !== record) {
      this.#discardSpare();
    }
    // A host whose last worker crashed has no worker left to release it.
    if (previous !== undefined && previous !== record && previous.workers === 0) {
      this.#dispose(previous);
    }
    await this.#manager.reload(worker.runner, { drain: { timeout: Number.POSITIVE_INFINITY } });
    this.#wakeActiveWaiters();
  }

  #start(record: HostRecord): Worker {
    record.workers += 1;
    const runner = new EveDevRunner({
      entry: record.host.entry,
      name: `eve-dev-${String(this.#workerCount++)}`,
      workerData: record.host.workerData,
    });
    const worker: Worker = {
      record,
      released: runner.terminated.then(async () => {
        record.workers -= 1;
        if (record.workers === 0 && record !== this.#current) {
          await this.#dispose(record);
        }
        this.#workers.delete(worker);
      }),
      runner,
    };
    this.#workers.add(worker);
    return worker;
  }

  /** Waits for a spare that is still booting: it started earlier than a new worker would. */
  async #takeSpare(record: HostRecord): Promise<Worker | undefined> {
    const spare = this.#spare;
    if (spare === undefined || spare.worker.record !== record || !(await spare.ready)) {
      return undefined;
    }
    if (this.#spare !== spare || spare.worker.runner.closed) {
      return undefined;
    }
    this.#spare = undefined;
    return spare.worker;
  }

  #discardSpare(): void {
    const spare = this.#spare;
    this.#spare = undefined;
    void spare?.worker.runner.close(new Error("Spare development worker discarded."));
  }

  #dispose(record: HostRecord): Promise<void> {
    if (record.disposal !== undefined || record.host.dispose === undefined) {
      return record.disposal ?? Promise.resolve();
    }
    const disposal = record.host
      .dispose()
      .catch((error: unknown) => {
        this.#logger.error(
          `[eve:dev] failed to dispose a retired dev host: ${toErrorMessage(error)}`,
        );
      })
      .finally(() => this.#disposals.delete(disposal));
    record.disposal = disposal;
    this.#disposals.add(disposal);
    return disposal;
  }

  #restartAfterCrash(): void {
    const crashed = this.#active;
    if (this.#closed || crashed === undefined) {
      return;
    }
    this.#active = undefined;
    this.#logger.error("[eve:dev] dev worker exited; restarting.");
    this.#enqueue(async () => {
      // A swap queued before the crash already replaced the crashed worker;
      // restarting now would swap retired code back in over it.
      if (this.#closed || this.#active !== undefined) return;
      await this.#swap(crashed.record, true);
    }).catch((error: unknown) => {
      this.#logger.error(`[eve:dev] dev worker restart failed: ${toErrorMessage(error)}`);
    });
  }

  async #waitForActiveWorker(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for the development worker to become ready.")),
        RUNNER_READY_TIMEOUT_MS,
      );
    });
    try {
      // A worker can become active and crash before this waiter resumes, so re-check.
      while (this.#active === undefined && !this.#closed) {
        this.#activeChange ??= Promise.withResolvers<void>();
        await Promise.race([this.#activeChange.promise, timedOut]);
      }
    } finally {
      clearTimeout(timer);
    }
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }
  }

  #wakeActiveWaiters(): void {
    this.#activeChange?.resolve();
    this.#activeChange = undefined;
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestAbort = new AbortController();
    const abortRequest = (cause?: unknown) => {
      if (!requestAbort.signal.aborted) requestAbort.abort(cause);
    };
    request.once("error", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) abortRequest();
    });

    try {
      // The signal rides the proxied request: a client that leaves before
      // response headers would otherwise keep the worker handler running, and
      // a retired worker holding that exchange would never retire.
      const publicRequest = createPublicRequest(request, requestAbort.signal);
      stampDevelopmentClientAddress(
        publicRequest.headers,
        request.socket.remoteAddress ?? undefined,
        this.#clientAddressSecret,
      );
      const controlResponse = await this.#controlHandler?.(publicRequest);
      if (controlResponse !== undefined) {
        await writeResponse(response, controlResponse, requestAbort.signal);
        return;
      }

      await this.#waitForActiveWorker();
      const workerResponse = await this.#manager.fetch(publicRequest);
      await writeResponse(response, workerResponse, requestAbort.signal);
    } catch (error) {
      if (!requestAbort.signal.aborted) writeRequestError(response, error);
    } finally {
      request.off("error", abortRequest);
    }
  }

  async #handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    try {
      stampDevelopmentClientAddress(
        request.headers,
        request.socket.remoteAddress ?? undefined,
        this.#clientAddressSecret,
      );
      await this.#waitForActiveWorker();
      await this.#manager.upgrade({ node: { head, req: request, socket } });
    } catch {
      if (!socket.destroyed) socket.destroy();
    }
  }
}
