/**
 * The Slack Web API surface eve's Slack channel drives and the tests
 * exercise, as a typed request/response map.
 *
 * The double in `mock-slack.ts` is a mapped type over these keys, so
 * `allow("chat.postMesage")` is a compile error rather than a stub that
 * silently never matches, and a stubbed response is shape-checked
 * against the method answering it. Adding a method here without
 * teaching the double about it is a compile error too, and
 * `slack-api-contract.test.ts` fails on an entry that no Slack test
 * stubs.
 *
 * The channel also issues `chat.startStream`, `chat.appendStream`,
 * `chat.stopStream` and `chat.delete`. They are absent until a test
 * needs one: a test that stubs an unlisted method fails to compile
 * until its entry is added.
 *
 * `response` is always the success shape. A Slack-level `{ ok: false }`
 * and an HTTP-level failure are separate paths on the double: one
 * arrives as an envelope the caller inspects, the other as a thrown
 * `SlackApiError`.
 *
 * `request` is declared in Slack's own logical types — `limit` is a
 * number because Slack documents a number — but the double never sees
 * those types. It sees what came off the wire, which is what
 * {@link SlackApiRequest} projects them to.
 */

/** A Slack message as the Web API returns it inside a response. */
export type SlackRawMessage = Record<string, unknown>;

export interface SlackApiContract {
  "assistant.threads.setStatus": {
    request: {
      channel_id: string;
      thread_ts: string;
      status: string;
      loading_messages?: readonly string[];
    };
    response: { ok: true };
  };

  "auth.test": {
    request: Record<string, unknown>;
    response: {
      ok: true;
      app_id?: string;
      bot_id?: string;
      team?: string;
      team_id?: string;
      url?: string;
      user?: string;
      user_id?: string;
    };
  };

  "chat.getPermalink": {
    request: { channel: string; message_ts: string };
    response: { ok: true; channel?: string; permalink: string };
  };

  "chat.postEphemeral": {
    request: {
      channel: string;
      user: string;
      text?: string;
      blocks?: unknown;
      markdown_text?: string;
      thread_ts?: string;
    };
    response: { ok: true; message_ts: string };
  };

  "chat.postMessage": {
    request: {
      channel: string;
      text?: string;
      blocks?: unknown;
      markdown_text?: string;
      thread_ts?: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    };
    response: { ok: true; channel?: string; ts: string; message?: SlackRawMessage };
  };

  "chat.update": {
    request: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: unknown;
      markdown_text?: string;
    };
    response: { ok: true; channel?: string; ts: string };
  };

  "conversations.info": {
    request: { channel: string };
    response: { ok: true; channel: Record<string, unknown> };
  };

  "conversations.open": {
    request: { users: string };
    response: { ok: true; channel: { id: string } };
  };

  "conversations.replies": {
    request: { channel: string; ts: string; limit?: number; cursor?: string };
    response: {
      ok: true;
      messages: readonly SlackRawMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
  };

  "files.completeUploadExternal": {
    request: {
      files: readonly { id: string; title?: string }[];
      channel_id?: string;
      initial_comment?: string;
      thread_ts?: string;
    };
    response: { ok: true; files: readonly { id: string; title?: string }[] };
  };

  "files.getUploadURLExternal": {
    request: { filename: string; length: number; alt_txt?: string; snippet_type?: string };
    response: { ok: true; upload_url: string; file_id: string };
  };

  "users.info": {
    request: { user: string };
    response: { ok: true; user: Record<string, unknown> };
  };

  "views.open": {
    request: { view: unknown; trigger_id?: string; interactivity_pointer?: string };
    response: { ok: true; view: Record<string, unknown> };
  };

  "views.update": {
    request: { view: unknown; view_id: string };
    response: { ok: true; view: Record<string, unknown> };
  };
}

/** Every Slack Web API method the channel drives. */
export type SlackApiMethod = keyof SlackApiContract;

/**
 * One request field as it arrives, rather than as it was written.
 *
 * `callSlackApi` form-encodes every outbound body through
 * `encodeSlackApiBody`, which stringifies scalars and JSON-encodes
 * everything else; `decodeSlackApiBody` parses back only the values
 * starting `[` or `{`. Arrays and objects therefore round-trip, and a
 * number or boolean does not: production's `limit: 50` is read back as
 * `"50"`, and `unfurl_links: true` as `"true"`.
 *
 * The two JSON-encoded methods (`views.open`, the answered-card
 * `chat.update`) do round-trip scalars, but neither declares a number
 * or boolean field, so one projection covers both encodings.
 */
type SlackWireValue<V> = V extends number | boolean ? string : V;

/** A whole request as the double receives it. */
type SlackWireRequest<T> = { [K in keyof T]: SlackWireValue<T[K]> };

/**
 * A request in the shape it reaches the double, which is the shape every
 * stub predicate and every assertion reads.
 *
 * The wire shape, not `SlackApiContract[M]["request"]`: a form-encoded
 * body carries `"50"`, so `.with({ limit: 50 })` is a compile error
 * here instead of a constraint no call could satisfy.
 */
export type SlackApiRequest<M extends SlackApiMethod> = SlackWireRequest<
  SlackApiContract[M]["request"]
>;

export type SlackApiResponseFor<M extends SlackApiMethod> = SlackApiContract[M]["response"];

/**
 * Runtime list of the contract's keys. A mapped record, so both a
 * missing key and a key that is not in {@link SlackApiContract} are
 * compile errors.
 */
const SLACK_API_METHOD_SET: { readonly [M in SlackApiMethod]: true } = {
  "assistant.threads.setStatus": true,
  "auth.test": true,
  "chat.getPermalink": true,
  "chat.postEphemeral": true,
  "chat.postMessage": true,
  "chat.update": true,
  "conversations.info": true,
  "conversations.open": true,
  "conversations.replies": true,
  "files.completeUploadExternal": true,
  "files.getUploadURLExternal": true,
  "users.info": true,
  "views.open": true,
  "views.update": true,
};

export const SLACK_API_METHODS: readonly SlackApiMethod[] = Object.keys(
  SLACK_API_METHOD_SET,
).sort() as SlackApiMethod[];

/**
 * The two legs of the file-upload handshake that are not Web API method
 * calls: the raw bytes POST to the URL `files.getUploadURLExternal`
 * hands out, and an authenticated `url_private` download. The double
 * records them under these names so tests can assert on them. They sit
 * outside {@link SlackApiContract}, which describes method calls: these
 * have no method name, no form-encoded body and no JSON response.
 */
export type SlackTransportLeg = "files.upload" | "files.download";
