import type { ClientSession } from "#client/session.js";
import type { ClientAgentSession } from "#client/agent-session.js";
import { ClientError } from "#client/client-error.js";
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
  readonly sessionId: string;
  readonly child?: Node;
  readonly excluded?: AgentObservationReason;
}
interface Node {
  readonly reader: ClientSession | ClientAgentSession;
  readonly conversation: Conversation;
  readonly depth: number;
  readonly edges: Map<string, Edge>;
  key?: string;
  alias?: Node;
  cursor: number;
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

  get active(): boolean {
    return this.#active;
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
      depth,
      edges: new Map(),
      cursor: 0,
      status: "queued",
      caughtUp: false,
      readyAt: 0,
      failures: 0,
      idleReads: 0,
    };
  }

  #discover(parent: Node): void {
    for (const child of Object.values(parent.conversation.view.children)) {
      if (parent.edges.has(child.sessionId)) continue;
      const depth = parent.depth + 1;
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
      if (excluded === undefined && this.#nodes.size >= DESCENDANT_MAX_SESSIONS)
        excluded = "session-limit";
      if (excluded !== undefined) {
        parent.edges.set(child.sessionId, { sessionId: child.sessionId, excluded });
        continue;
      }
      const node = this.#node(
        parent.reader.agent({
          type: "child.opened",
          data: child,
          meta: {
            at: child.startedAt,
            endOfLine: true,
            position: { line: child.introducedAt, index: 0 },
          },
        }),
        new Conversation(),
        depth,
      );
      this.#nodes.add(node);
      parent.edges.set(child.sessionId, { sessionId: child.sessionId, child: node });
    }
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#active) return;
    let active = [...this.#nodes].filter((node) => node.controller !== undefined).length;
    let next = Infinity;
    for (const node of [...this.#nodes].sort((a, b) => a.readyAt - b.readyAt)) {
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
    node.controller = controller;
    node.status = "following";
    node.reason = undefined;
    node.caughtUp = false;
    this.#publish();
    const lease = setTimeout(() => controller.abort(), 10_000);
    controller.signal.addEventListener("abort", () => clearTimeout(lease), { once: true });
    const before = node.cursor;
    void (async () => {
      try {
        // Retry waits belong to the scheduler, so a disconnected child releases its request slot.
        const reader = node.reader as ClientAgentSession;
        let reachedTail = false;
        for await (const { cursor, event } of reader.follow(
          {
            signal: controller.signal,
            startIndex: node.cursor,
            follow: false,
            streamReconnectPolicy: { reconnect: false },
          },
          (key) => {
            if (!this.#active || generation !== this.#generation || controller.signal.aborted)
              throw new Error("Observation stopped.");
            if (node.key !== undefined && node.key !== key)
              throw new ClientError(422, "Descendant reader identity changed.");
            node.key = key;
            const existing = this.#identities.get(key);
            if (existing !== undefined && existing !== node) {
              node.alias = existing;
              controller.abort();
            } else this.#identities.set(key, node);
          },
          () => {
            reachedTail = true;
          },
        )) {
          if (!this.#active || generation !== this.#generation || controller.signal.aborted) return;
          node.conversation.observe(event);
          if (event.meta.endOfLine !== false) {
            node.cursor = cursor;
            this.#discover(node);
            this.#publish();
            this.#schedule();
          }
        }
        if (!this.#active || generation !== this.#generation) return;
        if (!controller.signal.aborted) {
          if (!reachedTail) throw new Error("The descendant read ended before its captured tail.");
          node.caughtUp = true;
          node.status = "idle";
          node.failures = 0;
          node.idleReads = node.cursor === before ? node.idleReads + 1 : 0;
          node.readyAt = Date.now() + Math.min(10_000, 1000 * 2 ** Math.min(node.idleReads, 4));
        } else {
          node.status = "queued";
          node.readyAt = Date.now();
        }
      } catch (error) {
        if (!this.#active || generation !== this.#generation) return;
        if (controller.signal.aborted) {
          node.status = "queued";
          node.readyAt = Date.now();
        } else {
          node.failures += 1;
          const status = error instanceof ClientError ? error.status : undefined;
          const retryable =
            status === undefined || [404, 409, 425, 500, 502, 503, 504].includes(status);
          node.status = retryable && node.failures < 12 ? "interrupted" : "unavailable";
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
          node.readyAt = Date.now() + Math.min(5000, 250 * 2 ** Math.min(node.failures - 1, 5));
        }
      } finally {
        clearTimeout(lease);
        if (generation === this.#generation) {
          node.controller = undefined;
          if (controller.signal.aborted && node.status === "following") {
            node.status = "queued";
            node.readyAt = Date.now();
          }
          node.conversation.discardUncommitted();
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
      for (const edge of node.edges.values()) {
        if (edge.child === undefined) {
          node.conversation.observeAgent(edge.sessionId, {
            status: "not-followed",
            reason: edge.excluded,
          });
          continue;
        }
        const child = edge.child.alias ?? edge.child;
        if (next.has(child)) {
          node.conversation.observeAgent(edge.sessionId, {
            status: "not-followed",
            reason: "cycle",
          });
          continue;
        }
        visit(child, next);
        node.conversation.observeAgent(edge.sessionId, {
          status: child.status,
          key: child.key,
          conversation: child.conversation.state,
          position: child.cursor,
          caughtUp: child.caughtUp,
          reason: child.reason,
        });
      }
    };
    visit(this.#root, new Set());
    this.#onChange();
  }
}
