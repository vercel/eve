import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";

/** Who wrote a board message, as the board verified it. */
export interface BoardAuthor {
  /** The actor ID: `principal` or `principal+profile`, such as `slack:user:U0456`. */
  readonly actor: string;
  readonly principal: string;
  readonly profile: string | null;
  readonly session: string | null;
}

/** A board actor's display details. */
export interface BoardActor {
  /** `person`, `external` (a synced platform user), `agent`, `deployment`, or `workflow`. */
  readonly kind: string;
  readonly handle: string;
  readonly name: string;
}

/** A file attached to a board message. */
export interface BoardAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

/** A board message, as the board's HTTP API returns it. */
export interface BoardMessage {
  readonly id: string;
  readonly channel: string;
  readonly text: string;
  /** The thread's root message ID, or `null` for a root. */
  readonly re: string | null;
  /**
   * The thread's key: unique across boards and store resets, unlike message IDs, which are
   * positions in one board's log.
   */
  readonly thread: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly by: BoardAuthor;
  readonly author: BoardActor | null;
  readonly attachments: readonly BoardAttachment[];
  readonly createdAt: string;
  readonly deleted: boolean;
  /** Set when a schedule posted it. */
  readonly schedule?: { readonly id: string; readonly n: number };
}

/** A board event, as a watcher match carries it. */
export interface BoardEvent {
  readonly cursor: string;
  readonly type: string;
  readonly createdAt: string;
  /** The message the event concerns, as it is after the event. */
  readonly message?: BoardMessage;
}

/** One match of a registered watcher, leased to the caller that pulled it. */
export interface BoardMatch {
  readonly id: string;
  readonly watcher: string;
  readonly lease: string;
  readonly attempt: number;
  readonly event: BoardEvent;
}

/** A registered watcher: the tail expression it matches. */
export interface BoardWatch {
  readonly tail: string;
  readonly when: "matches" | "enters";
}

/** What a caller registers with a board: its watchers and where to wake it. */
export interface BoardRegistrationInput {
  /** The base URL the board wakes at `<url>/wake`, or `null` to pull without wake-ups. */
  readonly url?: string | null;
  /** The base path on the caller's own Vercel project, on a board whose discovery says `wake_by_path`. */
  readonly path?: string | null;
  readonly branch?: string | null;
  readonly watch: Readonly<Record<string, BoardWatch>>;
}

/** A caller's registration, as the board holds it. */
export interface BoardRegistration extends BoardRegistrationInput {
  readonly owner: string;
  readonly hash: string;
}

/** The board's discovery document. */
export interface BoardDiscovery {
  readonly version: string;
  readonly url: string;
  readonly wake_by_path?: boolean;
}

/** A whole thread: its root and every reply. */
export interface BoardThread {
  readonly message: BoardMessage;
  readonly replies: readonly BoardMessage[];
}

/** A thread at a glance. */
export interface BoardThreadSummary {
  readonly message: BoardMessage;
  readonly replies: number;
  readonly last: BoardMessage | null;
}

/** A channel's path and size. */
export interface BoardChannelSummary {
  readonly path: string;
  readonly messages: number;
  readonly threads: number;
}

/** Filters for listing threads. */
export interface BoardThreadsQuery {
  readonly channel?: string;
  readonly by?: string;
  readonly mentions?: string;
  readonly label?: readonly string[];
  readonly text?: string;
  readonly limit?: number;
}

/** Options for a new thread or a reply. */
export interface BoardPostOptions {
  readonly text: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** Keep the message on the board: it doesn't reach synced Slack or GitHub threads. */
  readonly noSync?: boolean;
  /** An idempotency key: the same `id` from the same profile never posts twice. */
  readonly id?: string;
}

/** HTTP transport overrides, used by tests and proxies. */
export interface BoardApiOptions {
  readonly fetch?: typeof globalThis.fetch;
}

/** How eve authenticates to the board. */
export interface BoardCredentials {
  /**
   * An OIDC token whose audience is the board's URL. Defaults to `BOARD_TOKEN`, then to the
   * deployment's Vercel OIDC token exchanged for the board's audience.
   */
  readonly token?: string | (() => string | Promise<string>);
}

/** Options for {@link createBoardClient}. */
export interface BoardClientOptions {
  /** The board's full URL, as its discovery returns it: `https://team.example/api/board`. */
  readonly url: string;
  /** The profile eve writes as, under its verified principal. */
  readonly profile: string;
  /** Recorded on writes as `by.session`. */
  readonly session?: string;
  readonly api?: BoardApiOptions;
  readonly credentials?: BoardCredentials;
}

/** A board request that failed, with the board's error code and message. */
export class BoardRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code: string; message: string; status: number }) {
    super(input.message);
    this.name = "BoardRequestError";
    this.code = input.code;
    this.status = input.status;
  }
}

/** The board's HTTP API, as eve uses it. */
export interface BoardClient {
  readonly url: string;
  discovery(): Promise<BoardDiscovery>;
  me(): Promise<{ readonly principal: string; readonly actor: string }>;
  watchers(): Promise<readonly BoardRegistration[]>;
  register(input: BoardRegistrationInput): Promise<BoardRegistration>;
  matches(options?: {
    readonly limit?: number;
    readonly wait?: number;
  }): Promise<readonly BoardMatch[]>;
  ack(match: BoardMatch, outcome?: { readonly error?: string }): Promise<void>;
  post(channel: string, options: BoardPostOptions): Promise<BoardMessage>;
  reply(id: string, options: BoardPostOptions): Promise<BoardMessage>;
  react(id: string, emoji: string, options?: { readonly remove?: boolean }): Promise<void>;
  label(
    id: string,
    change: { readonly set?: Record<string, string>; readonly unset?: readonly string[] },
  ): Promise<void>;
  typing(id: string, status?: string): Promise<void>;
  thread(id: string): Promise<BoardThread>;
  threads(query?: BoardThreadsQuery): Promise<readonly BoardThreadSummary[]>;
  channels(): Promise<readonly BoardChannelSummary[]>;
  download(attachmentId: string): Promise<Response>;
}

/** Creates a client for the board at `options.url`. */
export function createBoardClient(options: BoardClientOptions): BoardClient {
  const base = options.url.replace(/\/+$/, "");
  const fetchImpl = options.api?.fetch ?? globalThis.fetch;

  async function headers(): Promise<Record<string, string>> {
    const token = await resolveToken(base, options.credentials);
    return {
      authorization: `Bearer ${token}`,
      // On Vercel, Deployment Protection's Trusted Sources reads this header; the board reads the bearer.
      ...(process.env.VERCEL === "1" && { "x-vercel-trusted-oidc-idp-token": token }),
      "x-board-profile": options.profile,
      ...(options.session !== undefined && { "x-board-session": options.session.slice(0, 200) }),
    };
  }

  async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(await headers()),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      method,
    });
    if (!response.ok) throw await requestError(method, path, response);
    return response;
  }

  const json = async <T>(method: "GET" | "POST", path: string, body?: unknown) =>
    (await (await send(method, path, body)).json()) as T;

  return {
    url: base,
    async discovery() {
      // Discovery takes no token, but Deployment Protection's Trusted Sources still needs one.
      const response = await fetchImpl(base, { headers: await headers(), method: "GET" });
      if (!response.ok) throw await requestError("GET", "/", response);
      return (await response.json()) as BoardDiscovery;
    },
    me: () => json("GET", "/me"),
    async watchers() {
      return (await json<{ watchers: BoardRegistration[] }>("GET", "/watchers")).watchers;
    },
    register: (input) => json("POST", "/watchers", input),
    async matches(query = {}) {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.wait !== undefined) params.set("wait", String(query.wait));
      const suffix = params.size > 0 ? `?${params}` : "";
      return (await json<{ matches: BoardMatch[] }>("GET", `/watchers/matches${suffix}`)).matches;
    },
    async ack(match, outcome = {}) {
      await send("POST", `/watchers/matches/${encodeURIComponent(match.id)}/ack`, {
        lease: match.lease,
        ...(outcome.error !== undefined && { error: outcome.error.slice(0, 1000) }),
      });
    },
    async post(channel, post) {
      return (await json<{ message: BoardMessage }>("POST", "/messages", { channel, ...post }))
        .message;
    },
    async reply(id, post) {
      return (await json<{ message: BoardMessage }>("POST", "/messages", { re: id, ...post }))
        .message;
    },
    async react(id, emoji, reaction = {}) {
      await send("POST", `/messages/${encodeURIComponent(id)}/reactions`, {
        emoji,
        ...(reaction.remove === true && { remove: true }),
      });
    },
    async label(id, change) {
      await send("POST", `/messages/${encodeURIComponent(id)}/labels`, change);
    },
    async typing(id, status) {
      await send(
        "POST",
        `/messages/${encodeURIComponent(id)}/typing`,
        status === undefined ? {} : { status: status.slice(0, 100) },
      );
    },
    thread: (id) => json("GET", `/messages/${encodeURIComponent(id)}`),
    async threads(query = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const entry of value) params.append(key, String(entry));
        else params.set(key, String(value));
      }
      const suffix = params.size > 0 ? `?${params}` : "";
      return (await json<{ threads: BoardThreadSummary[] }>("GET", `/threads${suffix}`)).threads;
    },
    async channels() {
      return (await json<{ channels: BoardChannelSummary[] }>("GET", "/channels")).channels;
    },
    download: (attachmentId) => send("GET", `/attachments/${encodeURIComponent(attachmentId)}`),
  };
}

async function resolveToken(
  audience: string,
  credentials: BoardCredentials | undefined,
): Promise<string> {
  const explicit = credentials?.token;
  if (typeof explicit === "function") return await explicit();
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.BOARD_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return await getVercelOidcToken({ audience });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Couldn't get an OIDC token for the board at ${audience}: ${reason}. On Vercel, eve uses the ` +
        "deployment's OIDC token. Locally, run `vercel link` and `vercel env pull`, or set BOARD_TOKEN.",
      { cause: error },
    );
  }
}

async function requestError(
  method: string,
  path: string,
  response: Response,
): Promise<BoardRequestError> {
  let code = "http_error";
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") detail = body.error.message;
  } catch {
    // Not the board's JSON error, such as a Deployment Protection page.
  }
  const hint =
    response.status === 401 && code === "http_error"
      ? " The board may be behind Vercel Deployment Protection: add this project to its Trusted Sources."
      : "";
  return new BoardRequestError({
    code,
    message: `Board ${method} ${path} failed with ${response.status} ${code}: ${detail}.${hint}`,
    status: response.status,
  });
}
