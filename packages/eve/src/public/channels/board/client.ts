import {
  board as boardHandle,
  type Board as BoardHandle,
  type MatchView,
  type MessageView,
  type ScheduleView,
  type Written,
} from "#compiled/@vercel/board/index.js";

/** Who wrote a board message, as the board verified it. */
export interface BoardAuthor {
  /** The actor ID: `principal` or `principal+profile`, such as `vercel:user:u_abc+claude`. */
  readonly actor: string;
  readonly principal: string;
  readonly profile: string | null;
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

/** The state the board keeps on a thread that is a task. */
export interface BoardTaskState {
  /** `waiting`, `ready`, `claimed`, `blocked`, `completed`, `failed`, or `canceled`. */
  readonly state: string;
  /** The principal that made the thread a task. */
  readonly owner: string;
  /** Who holds it, until when. A claim whose `until` has passed is over. */
  readonly claim: { readonly actor: string; readonly until: string } | null;
  readonly blocked: { readonly kind: string | null; readonly reason: string } | null;
  readonly result: string | null;
  readonly reason: string | null;
}

/** A board message, as the board returns it. */
export interface BoardMessage {
  readonly id: string;
  readonly channel: string;
  readonly text: string;
  /** The thread's root message ID, or `null` for a root. */
  readonly re: string | null;
  /** The thread's key, unique across boards and store resets, unlike message IDs. */
  readonly thread: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly by: BoardAuthor;
  readonly author: BoardActor | null;
  readonly attachments: readonly BoardAttachment[];
  readonly createdAt: string;
  readonly deleted: boolean;
  /** Set when a schedule posted it. */
  readonly schedule?: { readonly id: string; readonly n: number };
  /** Set on a root that is a task. */
  readonly task?: BoardTaskState;
}

/** A message the caller just wrote. */
export interface BoardWrittenMessage extends BoardMessage {
  /** Handles the text mentioned that matched no one on the board, so they notified no one. */
  readonly unknownMentions?: readonly string[];
}

/** A whole thread: its root and every reply. */
export interface BoardThread {
  readonly message: BoardMessage;
  readonly replies: readonly BoardMessage[];
}

export interface BoardThreadSummary {
  readonly message: BoardMessage;
  readonly replies: number;
  readonly last: BoardMessage | null;
}

export interface BoardChannelSummary {
  readonly path: string;
}

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
  /** Keep the message on the board: it doesn't reach synced Slack, GitHub, or Linear threads. */
  readonly noSync?: boolean;
  /** An idempotency key: the same `id` from the same profile never posts twice. */
  readonly id?: string;
  /** Attachment IDs from {@link BoardClient.upload}, at most 10. `text` may be empty with them. */
  readonly attachments?: readonly string[];
}

export interface BoardScheduleOptions {
  readonly text: string;
  readonly noSync?: boolean;
  readonly in?: string;
  readonly at?: string;
  readonly every?: string;
  readonly times?: number;
  readonly until?: string;
}

export interface BoardSchedule {
  readonly id: string;
  readonly channel: string;
  readonly re: string | null;
  readonly text: string;
  readonly next: string | null;
  readonly state: string;
}

export interface BoardClaim {
  readonly taskId: string;
  readonly epoch: number;
  readonly token: string;
  readonly until: string;
}

export interface BoardClaimedTask extends BoardClaim {
  readonly task: BoardMessage;
}

export interface BoardHeldTask {
  renew(lease?: number): Promise<BoardClaim>;
  release(): Promise<void>;
  complete(result?: string): Promise<void>;
  fail(reason: string): Promise<void>;
  block(reason: string, options?: { readonly kind?: string }): Promise<void>;
}

export interface BoardReadyTaskQuery {
  readonly channel: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly from?: readonly string[];
  readonly lease?: number;
}

export interface BoardNewTask {
  readonly text: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly needs?: readonly string[];
  readonly noSync?: boolean;
  readonly id?: string;
}

export interface BoardEvent {
  readonly cursor: string;
  readonly type: string;
  readonly createdAt: string;
  readonly message?: BoardMessage;
}

export interface BoardMatch {
  readonly id: string;
  readonly watcher: string;
  readonly lease: string;
  readonly attempt: number;
  readonly event: BoardEvent;
}

export interface BoardRegistrationInput {
  readonly url?: string | null;
  readonly path?: string | null;
  readonly branch?: string | null;
  readonly watch: Readonly<Record<string, { readonly tail: string }>>;
}

export interface BoardRegistration extends BoardRegistrationInput {
  readonly owner: string;
  readonly hash: string;
}

export interface BoardDiscovery {
  readonly url: string;
  readonly wake_by_path?: boolean;
}

/** What a handle may do at most: `"all"`, permissions for every channel, or a map from channel pattern to permissions. */
export type BoardCan =
  | "all"
  | readonly BoardPermission[]
  | Readonly<Record<string, "all" | readonly BoardPermission[]>>;

/** A permission on a board channel. */
export type BoardPermission = "read" | "post" | "react" | "label" | "sync" | "manage";

export interface BoardTarget {
  readonly name?: string;
  readonly team?: string;
  readonly profile: string;
  readonly can?: BoardCan;
}

export interface BoardClient {
  readonly profile: string;
  discovery(): Promise<BoardDiscovery>;
  me(): Promise<{ readonly principal: string; readonly actor: string }>;
  watchers(): Promise<readonly BoardRegistration[]>;
  register(input: BoardRegistrationInput): Promise<BoardRegistration>;
  matches(options?: {
    readonly limit?: number;
    readonly wait?: number;
  }): Promise<readonly BoardMatch[]>;
  ack(match: BoardMatch, outcome?: { readonly error?: string }): Promise<void>;
  post(channel: string, options: BoardPostOptions): Promise<BoardWrittenMessage>;
  reply(id: string, options: BoardPostOptions): Promise<BoardWrittenMessage>;
  upload(file: {
    readonly data: Uint8Array;
    readonly name: string;
    readonly type?: string;
  }): Promise<BoardAttachment>;
  react(id: string, emoji: string, options?: { readonly remove?: boolean }): Promise<void>;
  label(
    id: string,
    change: { readonly set?: Record<string, string>; readonly unset?: readonly string[] },
  ): Promise<void>;
  typing(id: string, status?: string): Promise<void>;
  thread(id: string): Promise<BoardThread>;
  linked(url: string): Promise<BoardThread>;
  threads(query?: BoardThreadsQuery): Promise<readonly BoardThreadSummary[]>;
  channels(): Promise<readonly BoardChannelSummary[]>;
  download(attachmentId: string): Promise<Response>;
  schedule(
    target: { readonly re: string } | { readonly channel: string },
    options: BoardScheduleOptions,
  ): Promise<BoardSchedule>;
  cancelSchedule(id: string): Promise<{ readonly canceled: boolean }>;
  claimReady(query: BoardReadyTaskQuery): Promise<BoardClaimedTask | null>;
  claimedTasks(channel: string): Promise<readonly BoardMessage[]>;
  held(claim: BoardClaim): BoardHeldTask;
  createTask(channel: string, task: BoardNewTask): Promise<BoardMessage>;
}

export const BOARD_MAX_LEASE_SECONDS = 300;

export function boardErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const handles = new Map<string, BoardHandle>();
const principals = new Map<string, Promise<{ principal: string; actor: string }>>();

function handleKey(target: BoardTarget): string {
  return JSON.stringify([
    target.name ?? null,
    target.team ?? null,
    process.env.BOARD_URL?.trim() || null,
    process.env.BOARD_TOKEN ?? null,
  ]);
}

function baseHandle(target: BoardTarget): BoardHandle {
  const key = handleKey(target);
  let handle = handles.get(key);
  if (handle === undefined) {
    handle = boardHandle({
      ...(target.name !== undefined && { name: target.name }),
      ...(target.team !== undefined && { team: target.team }),
    });
    handles.set(key, handle);
  }
  return handle;
}

export function createBoardClient(target: BoardTarget): BoardClient {
  const base = baseHandle(target);
  const handle = base.as(
    target.profile,
    target.can === undefined ? undefined : { can: target.can as never },
  );
  const meKey = `${handleKey(target)}\n${target.profile}\n${JSON.stringify(target.can ?? null)}`;

  const held = (claim: BoardClaim): BoardHeldTask => {
    const task = handle.tasks.held(claim.taskId, { epoch: claim.epoch, token: claim.token });
    return {
      async renew(lease) {
        const renewed = await task.renew(lease);
        return {
          epoch: renewed.epoch,
          taskId: claim.taskId,
          token: renewed.token,
          until: renewed.until,
        };
      },
      release: async () => void (await task.release()),
      complete: async (result) => void (await task.complete(result)),
      fail: async (reason) => void (await task.fail(reason)),
      block: async (reason, options) =>
        void (await task.block(
          reason,
          options?.kind === undefined ? undefined : { kind: options.kind },
        )),
    };
  };

  return {
    profile: target.profile,
    discovery: async () => await handle.discovery(),
    me: () => {
      let me = principals.get(meKey);
      if (me === undefined) {
        me = handle.me().then(
          ({ actor, principal }) => ({ actor, principal }),
          (error: unknown) => {
            principals.delete(meKey);
            throw error;
          },
        );
        principals.set(meKey, me);
      }
      return me;
    },
    watchers: async () => (await handle.watchers()).map(registrationOf),
    async register(input) {
      const watch = Object.fromEntries(
        Object.entries(input.watch).map(([name, { tail }]) => [name, { tail }]),
      );
      const where = input.path
        ? { branch: input.branch ?? null, path: input.path }
        : { url: input.url ?? null };
      return registrationOf(await handle.register({ ...where, watch } as never));
    },
    matches: async (options = {}) =>
      (
        await handle.matches({
          ...(options.limit !== undefined && { limit: options.limit }),
          ...(options.wait !== undefined && { wait: options.wait }),
        })
      ).map(matchOf),
    async ack(match, outcome = {}) {
      await handle.ack(match.id, {
        lease: match.lease,
        ...(outcome.error !== undefined && { error: outcome.error.slice(0, 500) }),
      });
    },
    post: async (channel, post) => writtenOf(await handle.post(channel, postOf(post))),
    reply: async (id, post) => writtenOf(await handle.reply(id, postOf(post))),
    upload: async (file) =>
      await handle.upload({
        data: file.data as Uint8Array<ArrayBuffer>,
        name: file.name,
        ...(file.type !== undefined && { type: file.type }),
      }),
    async react(id, emoji, reaction = {}) {
      await handle.react(id, emoji, reaction.remove === true ? { remove: true } : {});
    },
    async label(id, change) {
      await handle.label(id, {
        ...(change.set !== undefined && { set: change.set }),
        ...(change.unset !== undefined && { unset: [...change.unset] }),
      });
    },
    async typing(id, status) {
      await handle.typing(id, status === undefined ? undefined : status.slice(0, 50));
    },
    thread: async (id) => threadOf(await handle.thread(id)),
    linked: async (url) => threadOf(await handle.linked(url)),
    async threads(query = {}) {
      const page = await handle.threads({
        ...query,
        ...(query.label !== undefined && { label: [...query.label] }),
      } as never);
      return page.threads.map((summary) => ({
        last: summary.last === null ? null : messageOf(summary.last),
        message: messageOf(summary.message),
        replies: summary.replies,
      }));
    },
    channels: async () =>
      (await handle.channels()).channels.map((channel) => ({ path: channel.path })),
    download: async (attachmentId) => await handle.download(attachmentId),
    async schedule(target, options) {
      const schedule = await handle.schedule("re" in target ? { re: target.re } : target.channel, {
        text: options.text,
        ...(options.noSync !== undefined && { noSync: options.noSync }),
        ...(options.in !== undefined && { in: options.in }),
        ...(options.at !== undefined && { at: options.at }),
        ...(options.every !== undefined && { every: options.every }),
        ...(options.times !== undefined && { times: options.times }),
        ...(options.until !== undefined && { until: options.until }),
      } as never);
      return scheduleOf(schedule);
    },
    async cancelSchedule(id) {
      const { canceled } = await handle.cancelSchedule(id);
      return { canceled };
    },
    async claimReady(query) {
      const claim = await handle.tasks.claim({
        channel: query.channel,
        ...(query.label !== undefined && { label: { ...query.label } }),
        ...(query.from !== undefined && query.from.length > 0 && { from: [...query.from] }),
        ...(query.lease !== undefined && { lease: query.lease }),
      });
      if (claim === null) return null;
      return {
        epoch: claim.epoch,
        task: messageOf(claim.task),
        taskId: claim.task.id,
        token: claim.token,
        until: claim.until,
      };
    },
    async claimedTasks(channel) {
      const page = await handle.tasks.list({ channel, limit: 500, state: "claimed" });
      return page.tasks.map((summary) => messageOf(summary.message));
    },
    held,
    async createTask(channel, task) {
      const created = await handle.tasks.create(channel, {
        text: task.text,
        ...(task.labels !== undefined && { labels: { ...task.labels } }),
        ...(task.needs !== undefined && { needs: [...task.needs] }),
        ...(task.noSync !== undefined && { noSync: task.noSync }),
        ...(task.id !== undefined && { id: task.id }),
      });
      return messageOf(created.task);
    },
  };
}

function postOf(post: BoardPostOptions) {
  return {
    text: post.text,
    ...(post.labels !== undefined && { labels: { ...post.labels } }),
    ...(post.noSync !== undefined && { noSync: post.noSync }),
    ...(post.id !== undefined && { id: post.id }),
    ...(post.attachments !== undefined && { attachments: [...post.attachments] }),
  };
}

function messageOf(view: MessageView): BoardMessage {
  return view;
}

function writtenOf(written: Written<MessageView>): BoardWrittenMessage {
  const unknown = (written.mentions ?? [])
    .filter((mention) => mention.actor === null)
    .map((mention) => mention.written.replace(/^@/u, ""));
  return unknown.length === 0
    ? messageOf(written)
    : { ...messageOf(written), unknownMentions: unknown };
}

function threadOf(view: {
  readonly message: MessageView;
  readonly replies: readonly MessageView[];
}): BoardThread {
  return { message: messageOf(view.message), replies: view.replies.map(messageOf) };
}

function matchOf(match: MatchView): BoardMatch {
  return {
    attempt: match.attempt,
    event: {
      createdAt: match.event.createdAt,
      cursor: match.event.cursor,
      type: match.event.type,
      ...(match.event.message !== undefined && { message: messageOf(match.event.message) }),
    },
    id: match.id,
    lease: match.lease,
    watcher: match.watcher,
  };
}

function registrationOf(registration: {
  readonly owner: string;
  readonly hash: string;
  readonly url: string | null;
  readonly path?: string;
  readonly branch?: string;
  readonly watch: Readonly<Record<string, { readonly tail: string }>>;
}): BoardRegistration {
  return {
    hash: registration.hash,
    owner: registration.owner,
    url: registration.url,
    ...(registration.path !== undefined && { path: registration.path }),
    ...(registration.branch !== undefined && { branch: registration.branch }),
    watch: registration.watch,
  };
}

function scheduleOf(schedule: ScheduleView): BoardSchedule {
  return {
    channel: schedule.channel,
    id: schedule.id,
    next: schedule.next,
    re: schedule.re,
    state: schedule.state,
    text: schedule.text,
  };
}
