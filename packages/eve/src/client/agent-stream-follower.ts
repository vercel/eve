import type { ClientSession } from "#client/session.js";
import type { ClientAgentSession } from "#client/agent-session.js";
import { ClientError } from "#client/client-error.js";
import {
  DEFAULT_STREAM_RECONNECT_POLICY,
  RECONNECT_BACKOFF,
  isRetryableStreamError,
} from "#client/open-stream.js";
import { Conversation } from "#client/conversation.js";
import type {
  AgentObservation,
  AgentObservationReason,
  FollowAgents,
} from "#client/conversation-state.js";
import {
  DESCENDANT_MAX_DEPTH,
  DESCENDANT_MAX_READS,
  DESCENDANT_MAX_SESSIONS,
  localObservationKey,
} from "#protocol/descendant-observation.js";

interface Edge {
  readonly depths: Set<number>;
  child?: Node;
  excluded?: AgentObservationReason;
}
interface Node {
  reader: ClientSession | ClientAgentSession;
  readerDepth: number;
  readonly conversation: Conversation;
  readonly depths: Set<number>;
  readonly edges: Map<string, Edge>;
  key?: string;
  alias?: Node;
  status: Exclude<AgentObservation["status"], "not-followed">;
  caughtUp: boolean;
  reason?: AgentObservationReason;
  controller?: AbortController;
  readyAt: number;
  failures: number;
  idleReads: number;
}

/** One bounded scheduler and projection registry for the root's entire observed descendant graph. */
export class AgentStreamFollower {
  readonly #root: Node;
  readonly #nodes = new Set<Node>();
  readonly #identities = new Map<string, Node>();
  readonly #policy: FollowAgents;
  readonly #onChange: () => void;
  #active = false;
  #generation = 0;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(options: {
    session: ClientSession;
    conversation: Conversation;
    policy: FollowAgents;
    onChange: () => void;
  }) {
    this.#policy = options.policy;
    this.#onChange = options.onChange;
    this.#root = this.#node(options.session, options.conversation, 0);
    this.#root.key = localObservationKey(options.session.id);
    this.#identities.set(this.#root.key, this.#root);
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    for (const node of this.#nodes) {
      node.readyAt = 0;
      if (node.status === "interrupted" && node.reason === "detached") node.status = "queued";
    }
    this.reconcile();
  }

  /** Discovery sees committed projections, never a partially received opening. */
  reconcile(): void {
    if (!this.#active) return;
    this.#discover(this.#root);
    if (!this.#active) return;
    this.#publish();
    this.#schedule();
  }

  abortAll(): void {
    this.#active = false;
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const node of this.#nodes) {
      node.controller?.abort();
      node.controller = undefined;
      node.conversation.discardUncommitted();
      if (node.status !== "unavailable") {
        node.status = "interrupted";
        node.reason = "detached";
      }
    }
    this.#publish();
  }

  #node(reader: Node["reader"], conversation: Conversation, depth: number): Node {
    return {
      reader,
      conversation,
      readerDepth: depth,
      depths: new Set([depth]),
      edges: new Map(),
      status: "queued",
      caughtUp: false,
      readyAt: 0,
      failures: 0,
      idleReads: 0,
    };
  }

  #discover(parent: Node): void {
    const generation = this.#generation;
    for (const child of Object.values(parent.conversation.view.children)) {
      const edge: Edge = parent.edges.get(child.sessionId) ?? { depths: new Set<number>() };
      parent.edges.set(child.sessionId, edge);
      for (const parentDepth of parent.depths) {
        if (!this.#active || generation !== this.#generation) return;
        const depth = parentDepth + 1;
        if (edge.depths.has(depth)) continue;
        edge.depths.add(depth);
        let excluded: AgentObservationReason | undefined;
        if (depth > DESCENDANT_MAX_DEPTH) excluded = "depth-limit";
        else if (typeof this.#policy === "function") {
          try {
            if (
              !this.#policy({
                depth,
                name: child.name,
                sessionId: child.sessionId,
                owner: child.owner,
              })
            )
              excluded = "predicate";
          } catch {
            excluded = "predicate";
          }
        } else if (!this.#policy) excluded = "predicate";
        if (!this.#active || generation !== this.#generation) return;
        if (
          excluded === undefined &&
          edge.child === undefined &&
          this.#nodes.size >= DESCENDANT_MAX_SESSIONS
        )
          excluded = "session-limit";
        if (excluded !== undefined) {
          if (edge.child === undefined) edge.excluded = excluded;
          continue;
        }
        const reader = parent.reader.agent({
          type: "child.opened",
          data: child,
          meta: {
            at: child.startedAt,
            endOfLine: true,
            position: { line: child.introducedAt, index: 0 },
          },
        });
        if (edge.child === undefined) {
          edge.child = this.#node(reader, new Conversation(), depth);
          edge.child.readerDepth = parent.readerDepth + 1;
          edge.excluded = undefined;
          this.#nodes.add(edge.child);
        } else {
          const node = edge.child.alias ?? edge.child;
          if (parent.readerDepth + 1 < node.readerDepth) {
            node.reader = reader;
            node.readerDepth = parent.readerDepth + 1;
          }
          if (node !== this.#root && !node.depths.has(depth)) {
            node.depths.add(depth);
            this.#discover(node);
          }
        }
      }
    }
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#active) return;
    const generation = this.#generation;
    let active = [...this.#nodes].filter((node) => node.controller !== undefined).length;
    let next = Infinity;
    for (const node of [...this.#nodes].sort((a, b) => a.readyAt - b.readyAt)) {
      if (!this.#active || generation !== this.#generation) return;
      if (
        node.alias !== undefined ||
        node.controller !== undefined ||
        node.status === "unavailable"
      )
        continue;
      if (active < DESCENDANT_MAX_READS && node.readyAt <= Date.now()) {
        active += 1;
        this.#read(node);
      } else next = Math.min(next, node.readyAt);
    }
    if (active < DESCENDANT_MAX_READS && next !== Infinity)
      this.#timer = setTimeout(() => this.#schedule(), Math.max(1, next - Date.now()));
  }

  #read(node: Node): void {
    const generation = this.#generation;
    const controller = new AbortController();
    const current = () =>
      this.#active && generation === this.#generation && !controller.signal.aborted;
    const { conversation } = node;
    node.controller = controller;
    node.status = "following";
    node.reason = undefined;
    node.caughtUp = false;
    this.#publish();
    if (!current()) {
      controller.abort();
      return;
    }
    const lease = setTimeout(() => controller.abort(), 10_000);
    controller.signal.addEventListener("abort", () => clearTimeout(lease), { once: true });
    const before = conversation.view.position;
    void (async () => {
      try {
        // Retry waits belong to the scheduler, so a disconnected child releases its request slot.
        const reader = node.reader as ClientAgentSession;
        let reachedTail = false;
        for await (const { event } of reader.follow(
          {
            signal: controller.signal,
            startIndex: conversation.view.position,
            follow: false,
            streamReconnectPolicy: { reconnect: false },
          },
          (key) => {
            if (!current()) throw new Error("Observation stopped.");
            if (node.key !== undefined && node.key !== key)
              throw new ClientError(422, "Descendant reader identity changed.");
            node.key = key;
            const existing = this.#identities.get(key);
            if (existing !== undefined && existing !== node) {
              node.alias = existing;
              if (existing !== this.#root) {
                if (node.readerDepth < existing.readerDepth) {
                  existing.reader = node.reader;
                  existing.readerDepth = node.readerDepth;
                }
                for (const depth of node.depths) existing.depths.add(depth);
                this.#discover(existing);
              }
              controller.abort();
            } else this.#identities.set(key, node);
          },
          () => {
            reachedTail = true;
          },
          (position) => {
            if (!current() || position <= conversation.view.position) return;
            conversation.advancePosition(position);
            this.#publish();
          },
        )) {
          if (!current()) return;
          conversation.observe(event);
          if (event.meta.endOfLine !== false) {
            this.#discover(node);
            if (!current()) return;
            this.#publish();
            this.#schedule();
          }
        }
        if (!current()) return;
        if (!reachedTail)
          throw new Error("The descendant stream disconnected before its captured tail.");
        node.caughtUp = true;
        node.status = "idle";
        node.failures = 0;
        node.idleReads = conversation.view.position === before ? node.idleReads + 1 : 0;
        node.readyAt = Date.now() + Math.min(10_000, 1000 * 2 ** Math.min(node.idleReads, 4));
      } catch (error) {
        if (!current()) return;
        node.failures += 1;
        const status = error instanceof ClientError ? error.status : undefined;
        const retryable = isRetryableStreamError(error);
        node.status =
          retryable &&
          node.failures < DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy.maxAttempts
            ? "interrupted"
            : "unavailable";
        node.reason =
          status === 401 || status === 403
            ? "unauthorized"
            : status === 410
              ? "expired"
              : status === 422
                ? error instanceof ClientError && error.code === "cycle"
                  ? "cycle"
                  : "unsupported"
                : "transport";
        node.readyAt =
          Date.now() +
          Math.min(
            RECONNECT_BACKOFF.maxDelayMs,
            RECONNECT_BACKOFF.baseDelayMs * 2 ** Math.min(node.failures - 1, 5),
          );
      } finally {
        clearTimeout(lease);
        if (generation === this.#generation) {
          node.controller = undefined;
          if (controller.signal.aborted) {
            node.status = "queued";
            node.readyAt = Date.now();
          }
          conversation.discardUncommitted();
          if (this.#active) {
            this.#publish();
            this.#schedule();
          }
        }
      }
    })();
  }

  #publish(): void {
    const published = new Set<Node>();
    const visit = (node: Node, ancestors: ReadonlySet<Node>): void => {
      if (published.has(node)) return;
      published.add(node);
      const next = new Set([...ancestors, node]);
      for (const [sessionId, edge] of node.edges) {
        if (edge.child === undefined) {
          node.conversation.observeAgent(sessionId, {
            status: "not-followed",
            reason: edge.excluded,
          });
          continue;
        }
        const child = edge.child.alias ?? edge.child;
        if (next.has(child)) {
          node.conversation.observeAgent(sessionId, {
            status: "not-followed",
            reason: "cycle",
          });
          continue;
        }
        visit(child, next);
        node.conversation.observeAgent(sessionId, {
          status: child.status,
          key: child.key,
          conversation: child.conversation.state,
          position: child.conversation.view.position,
          caughtUp: child.caughtUp,
          reason: child.reason,
        });
      }
    };
    visit(this.#root, new Set());
    this.#onChange();
  }
}
