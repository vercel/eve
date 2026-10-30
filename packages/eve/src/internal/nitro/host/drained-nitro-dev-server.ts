import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  closeServer,
  createPublicRequest,
  writeRequestError,
  writeResponse,
} from "#internal/nitro/host/dev-server-http.js";
import {
  createNodeDevelopmentRunner,
  type DevelopmentRunner,
  type DevelopmentRunnerFactory,
} from "#internal/nitro/host/dev-runner.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { toErrorMessage } from "#shared/errors.js";

const RUNNER_READY_TIMEOUT_MS = 60_000;

export interface DrainedDevServerListener {
  close(): Promise<void>;
  readonly node: { readonly server: Server };
  ready(): Promise<void>;
  readonly url: string | undefined;
}

interface DevelopmentWorkerReplacement {
  readonly dispose?: () => Promise<void>;
  readonly entry: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

/** One built host. Its workspace outlives every runner started from it. */
interface WorkerHost {
  readonly dispose?: () => Promise<void>;
  disposed: boolean;
  readonly entry: string;
  /** Runners started from this host that have not been released yet. */
  runners: number;
  readonly workerData: Readonly<Record<string, unknown>>;
}

interface RunnerSlot {
  activeExchanges: number;
  readonly host: WorkerHost;
  quietListeners: Array<() => void>;
  releasePromise: Promise<void> | undefined;
  readonly runner: DevelopmentRunner;
}

interface SpareRunner {
  /** Resolves to whether the spare became ready. */
  readonly ready: Promise<boolean>;
  readonly slot: RunnerSlot;
}

interface DevServerLogger {
  error(message: unknown, ...details: unknown[]): unknown;
}

/**
 * Development server with drained worker replacement: `replaceWorker` swaps
 * to a ready candidate while the retired worker keeps serving the responses
 * and sockets it already admitted — without bound, a streaming turn can hold
 * one for minutes — and is terminated once its last exchange settles. Stock
 * Nitro's dev server terminates the previous worker as soon as the next one
 * attaches, which resets admitted work; this class exists solely to close
 * that gap and is intended to be deleted in favor of `createDevServer` once
 * equivalent drain semantics are available upstream.
 */
export class DrainedNitroDevServer {
  readonly #createRunner: DevelopmentRunnerFactory;
  readonly #draining = new Set<RunnerSlot>();
  readonly #listeners = new Set<{ beginClose(): Promise<void>; destroySockets(): void }>();
  readonly #logger: DevServerLogger;
  #active: RunnerSlot | undefined;
  #activeWaiters: Array<() => void> = [];
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #clientAddressSecret: string | undefined;
  #controlHandler: ((request: Request) => Promise<Response | undefined>) | undefined;
  /** Host of the active worker; its workspace stays until another host replaces it. */
  #currentHost: WorkerHost | undefined;
  #pendingSlot: RunnerSlot | undefined;
  #spare: SpareRunner | undefined;
  #replaceChain: Promise<void> = Promise.resolve();
  #runnerCounter = 0;

  constructor(
    logger: DevServerLogger = console,
    createRunner: DevelopmentRunnerFactory = createNodeDevelopmentRunner,
  ) {
    this.#createRunner = createRunner;
    this.#logger = logger;
  }

  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void {
    this.#controlHandler = handler;
  }

  /**
   * Enables signed client-address metadata on requests forwarded to
   * workers. Without it the worker only ever observes the parent's loopback
   * hop as the request's peer address.
   */
  setClientAddressSecret(secret: string): void {
    this.#clientAddressSecret = secret;
  }

  /**
   * Swaps to a ready worker built from `entry`. Throws without touching the
   * active worker when the candidate fails readiness. `dispose` is invoked
   * once the worker created here has fully retired (drained, crashed, or
   * closed at shutdown), so a caller can tie workspace cleanup to it.
   */
  replaceWorker(replacement: DevelopmentWorkerReplacement): Promise<void> {
    const host: WorkerHost = {
      dispose: replacement.dispose,
      disposed: false,
      entry: replacement.entry,
      runners: 0,
      workerData: replacement.workerData,
    };
    return this.#enqueueSwap(async () => await this.#swapTo(host, false));
  }

  /**
   * Swaps the active worker for a fresh one started from the same host, and
   * drains the old one. Node never unloads a module, so a worker keeps every
   * generation it imported; a fresh worker loads only the active one. Uses the
   * spare from {@link prepareSpareWorker} when it is ready.
   */
  recycleWorker(): Promise<void> {
    return this.#enqueueSwap(async () => {
      const host = this.#currentHost;
      if (host === undefined) {
        throw new Error("Development server has no worker to recycle.");
      }
      await this.#swapTo(host, true);
    });
  }

  /**
   * Starts a spare worker from the active host in the background, so the next
   * {@link recycleWorker} does not wait for a worker to boot. A spare for an
   * older host is discarded.
   */
  prepareSpareWorker(): void {
    const host = this.#currentHost;
    if (this.#closed || host === undefined || this.#spare?.slot.host === host) {
      return;
    }
    this.#discardSpare();

    const slot = this.#createSlot(host);
    let settle: (ready: boolean) => void = () => undefined;
    const spare: SpareRunner = {
      ready: new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
      slot,
    };
    // A spare that closes or fails readiness is never ready, so a recycle
    // waiting on it moves on instead of waiting out the readiness timeout.
    const forget = () => {
      settle(false);
      if (this.#spare !== spare) return;
      this.#spare = undefined;
      void this.#releaseSlot(slot);
    };
    this.#spare = spare;
    slot.runner.onceClosed(forget);
    slot.runner.waitForReady(RUNNER_READY_TIMEOUT_MS).then(() => settle(true), forget);
  }

  #enqueueSwap(swap: () => Promise<void>): Promise<void> {
    const next = this.#replaceChain.catch(() => undefined).then(swap);
    this.#replaceChain = next.catch(() => undefined);
    return next;
  }

  async #swapTo(host: WorkerHost, useSpare: boolean): Promise<void> {
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }

    let slot = useSpare ? await this.#takeSpare(host) : undefined;
    if (this.#closed) {
      if (slot !== undefined) await this.#releaseSlot(slot);
      throw new Error("Development server is closed.");
    }
    if (slot === undefined) {
      slot = this.#createSlot(host);
      this.#pendingSlot = slot;
      try {
        await slot.runner.waitForReady(RUNNER_READY_TIMEOUT_MS);
      } catch (error) {
        await slot.runner.close(error).catch(() => undefined);
        // A candidate host that never served has no further use for its workspace.
        await this.#releaseSlot(slot);
        throw error;
      } finally {
        this.#pendingSlot = undefined;
      }
    }

    if (this.#closed) {
      await this.#releaseSlot(slot);
      throw new Error("Development server closed before the worker was ready.");
    }

    const previous = this.#active;
    const previousHost = this.#currentHost;
    const activeSlot = slot;
    this.#active = activeSlot;
    this.#currentHost = host;
    if (this.#spare !== undefined && this.#spare.slot.host !== host) {
      this.#discardSpare();
    }
    // A host whose restart failed has no runner left to dispose it on release.
    if (previousHost !== undefined && previousHost !== host && previousHost.runners === 0) {
      void this.#disposeHost(previousHost);
    }
    activeSlot.runner.onceClosed(() => {
      void this.#handleRunnerClose(activeSlot);
    });
    this.#wakeActiveWaiters();

    if (previous !== undefined) {
      this.#drainInBackground(previous);
    }
  }

  #createSlot(host: WorkerHost): RunnerSlot {
    host.runners += 1;
    return {
      activeExchanges: 0,
      host,
      quietListeners: [],
      releasePromise: undefined,
      runner: this.#createRunner({
        entry: host.entry,
        name: `eve-dev-${String(this.#runnerCounter++)}`,
        workerData: host.workerData,
      }),
    };
  }

  // Waits for a spare that is still booting: it started earlier than a new worker would.
  async #takeSpare(host: WorkerHost): Promise<RunnerSlot | undefined> {
    const spare = this.#spare;
    if (spare === undefined || spare.slot.host !== host || !(await spare.ready)) {
      return undefined;
    }
    if (this.#spare !== spare || spare.slot.runner.closed) {
      return undefined;
    }
    this.#spare = undefined;
    return spare.slot;
  }

  #discardSpare(): void {
    const spare = this.#spare;
    this.#spare = undefined;
    if (spare !== undefined) {
      void this.#releaseSlot(spare.slot);
    }
  }

  listen(input: { readonly hostname: string; readonly port: number }): DrainedDevServerListener {
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
    const listenerState = {
      beginClose: () => {
        closePromise ??= closeServer(server).finally(() => {
          this.#listeners.delete(listenerState);
        });
        return closePromise;
      },
      destroySockets: () => {
        for (const socket of sockets) {
          socket.destroy();
        }
      },
    };
    this.#listeners.add(listenerState);

    return {
      async close() {
        const closed = listenerState.beginClose();
        listenerState.destroySockets();
        await closed;
      },
      node: { server },
      ready: async () => await ready,
      get url() {
        return url;
      },
    };
  }

  async waitForActiveRunner(timeoutMs: number = RUNNER_READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#active === undefined && !this.#closed) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the development worker to become ready.");
      }
      await new Promise<void>((resolvePromise) => {
        this.#activeWaiters.push(resolvePromise);
        setTimeout(resolvePromise, 100);
      });
    }
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#wakeActiveWaiters();

    // Terminate a candidate still waiting on readiness so the replace chain
    // settles within a bounded interval instead of the readiness timeout.
    // Terminate a booting spare too: a recycle may be waiting on it.
    await Promise.all(
      [this.#pendingSlot, this.#spare?.slot].map(
        async (slot) =>
          await slot?.runner
            .close(new Error("Development server is closing."))
            .catch(() => undefined),
      ),
    );
    await this.#replaceChain.catch(() => undefined);

    const listeners = [...this.#listeners];
    const listenerClosePromises = listeners.map((listener) => listener.beginClose());

    const slots = [this.#active, this.#spare?.slot, ...this.#draining].filter(
      (slot): slot is RunnerSlot => slot !== undefined,
    );
    const currentHost = this.#currentHost;
    this.#active = undefined;
    this.#currentHost = undefined;
    this.#spare = undefined;
    this.#draining.clear();
    await Promise.all(slots.map(async (slot) => await this.#releaseSlot(slot)));
    if (currentHost !== undefined && currentHost.runners === 0) {
      await this.#disposeHost(currentHost);
    }

    for (const listener of listeners) {
      listener.destroySockets();
    }
    await Promise.all(listenerClosePromises);
  }

  #releaseSlot(slot: RunnerSlot): Promise<void> {
    slot.releasePromise ??= this.#releaseSlotOnce(slot);
    return slot.releasePromise;
  }

  async #releaseSlotOnce(slot: RunnerSlot): Promise<void> {
    await slot.runner.close().catch(() => undefined);
    slot.host.runners -= 1;
    if (slot.host.runners === 0 && slot.host !== this.#currentHost) {
      await this.#disposeHost(slot.host);
    }
  }

  async #disposeHost(host: WorkerHost): Promise<void> {
    if (host.dispose === undefined || host.disposed) {
      return;
    }
    host.disposed = true;
    await host.dispose().catch((error) => {
      this.#logger.error(
        `[eve:dev] failed to dispose a retired dev host: ${toErrorMessage(error)}`,
      );
    });
  }

  async #handleRunnerClose(slot: RunnerSlot): Promise<void> {
    if (this.#closed || this.#active !== slot) {
      return;
    }
    this.#active = undefined;
    this.#logger.error("[eve:dev] dev worker exited; restarting.");
    const next = this.#replaceChain
      .catch(() => undefined)
      .then(async () => {
        // A replacement that was already in flight when the worker crashed
        // wins; restarting the crashed entry now would swap retired code back
        // in over the newer worker.
        if (this.#closed || this.#active !== undefined) {
          await this.#releaseSlot(slot);
          return;
        }
        // The host stays current, so releasing the crashed runner keeps its workspace.
        await this.#releaseSlot(slot);
        await this.#swapTo(slot.host, true);
      });
    this.#replaceChain = next.catch(() => undefined);
    try {
      await next;
    } catch (error) {
      this.#logger.error(`[eve:dev] dev worker restart failed: ${toErrorMessage(error)}`);
    }
  }

  #drainInBackground(slot: RunnerSlot): void {
    this.#draining.add(slot);
    const finishDrain = () => {
      void this.#releaseSlot(slot).finally(() => this.#draining.delete(slot));
    };
    if (slot.activeExchanges === 0) {
      finishDrain();
      return;
    }
    slot.quietListeners.push(finishDrain);
  }

  #beginExchange(slot: RunnerSlot): () => void {
    slot.activeExchanges += 1;
    let settled = false;
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      slot.activeExchanges -= 1;
      if (slot.activeExchanges === 0) {
        for (const listener of slot.quietListeners.splice(0)) {
          listener();
        }
      }
    };
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestAbort = new AbortController();
    const abortRequest = (cause?: unknown) => {
      if (!requestAbort.signal.aborted) {
        requestAbort.abort(cause);
      }
    };
    request.once("error", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) {
        abortRequest();
      }
    });

    let settle: (() => void) | undefined;
    try {
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

      await this.waitForActiveRunner();
      const slot = this.#active;
      if (slot === undefined) {
        throw new Error("Development worker is unavailable.");
      }
      settle = this.#beginExchange(slot);
      // The abort signal must ride the proxied request: without it a client
      // that disconnects before response headers arrive leaves the worker
      // handler running and the exchange pinned, so a retired worker holding
      // one would never drain.
      const workerResponse = await slot.runner.fetch(publicRequest, {
        signal: requestAbort.signal,
      });
      await writeResponse(response, workerResponse, requestAbort.signal);
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        writeRequestError(response, error);
      }
    } finally {
      settle?.();
      request.off("error", abortRequest);
    }
  }

  async #handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let settle: (() => void) | undefined;
    try {
      stampDevelopmentClientAddress(
        request.headers,
        request.socket.remoteAddress ?? undefined,
        this.#clientAddressSecret,
      );
      await this.waitForActiveRunner();
      const slot = this.#active;
      if (slot === undefined) {
        throw new Error("Development worker is unavailable.");
      }
      settle = this.#beginExchange(slot);
      socket.once("close", settle);
      socket.once("error", settle);
      await slot.runner.upgrade({ node: { head, req: request, socket } });
    } catch {
      settle?.();
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  #wakeActiveWaiters(): void {
    for (const wake of this.#activeWaiters.splice(0)) {
      wake();
    }
  }
}
