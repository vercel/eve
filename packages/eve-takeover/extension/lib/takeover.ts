import type { AuthFn } from "eve/channels/auth";
import {
  deriveTakeoverKeys,
  sealTakeoverGrant,
  STREAM_TOKEN_MAX_TTL_MS,
  type TakeoverKeys,
  type TakeoverProtocol,
  type TakeoverRequester,
} from "./keys.ts";
import { TAKEOVER_PROXY_SOURCE } from "./proxy-source.ts";
import { vercelSandboxPorts, type PortExposer } from "./expose.ts";

/** Sandbox port the proxy listens on and exposes while a takeover is open. */
export const DEFAULT_TAKEOVER_PORT = 4791;

/** How long a takeover stays open by default before the agent takes control back. */
export const DEFAULT_TAKEOVER_TTL_MS = 20 * 60 * 1000;

/** Path prefix of the viewer routes the takeover extension serves. */
export const TAKEOVER_ROUTE_PREFIX = "/takeover";

const TAKEOVER_DIR = "/tmp/eve-takeover";
const PROXY_PATH = `${TAKEOVER_DIR}/proxy.mjs`;
const PID_PATH = `${TAKEOVER_DIR}/proxy.pid`;

/** The slice of an eve sandbox session takeover uses. */
export interface TakeoverSandbox {
  run(options: {
    readonly command: string;
    readonly env?: Record<string, string>;
    readonly signal?: AbortSignal;
  }): PromiseLike<{
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }>;
  writeTextFile(options: { readonly path: string; readonly content: string }): PromiseLike<void>;
}

/** The viewer's sign-in as eve's route auth resolved it. */
export type TakeoverViewer = TakeoverRequester;

export interface TakeoverOptions {
  /** At least 32 characters. Signs stream tokens and seals links; keep it out of the sandbox. */
  readonly secret: string;
  /**
   * Route auth for the viewer, the same `AuthFn` walk an eve channel takes. It
   * runs on a browser navigation, so it must accept your app's session cookie.
   */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /**
   * Whether the signed-in viewer is the person whose turn asked for the
   * takeover. Defaults to the same authenticator and principal. Override it
   * when people sign in to the viewer differently than they reach the agent,
   * such as Slack for chat and an SSO session for the web.
   */
  readonly isRequester?: (
    viewer: TakeoverViewer,
    requester: TakeoverRequester,
  ) => boolean | Promise<boolean>;
  /** Public origin of the agent, for links. Defaults from Vercel's environment. */
  readonly baseUrl?: string;
  /** Where to send a viewer who isn't signed in. Receives the takeover path to return to. */
  readonly signInUrl?: (returnTo: string) => string;
  /** How long a takeover stays open. Defaults to 20 minutes. */
  readonly ttlMs?: number;
  /** Makes the proxy's sandbox port reachable. Defaults to Vercel Sandbox port routes. */
  readonly expose?: PortExposer;
  /** Sandbox port for the proxy. Defaults to 4791. */
  readonly port?: number;
}

export interface Takeover {
  readonly options: TakeoverOptions;
  readonly keys: TakeoverKeys;
  readonly ttlMs: number;
  readonly port: number;
  readonly expose: PortExposer;
  baseUrl(): string | null;
}

/**
 * Shared takeover configuration. Pass the same value to the takeover
 * extension, which serves the viewer, and to each extension that offers a
 * takeover tool, such as `@eve/agent-browser` and `@eve/agent-desktop`.
 */
export function defineTakeover(options: TakeoverOptions): Takeover {
  const keys = deriveTakeoverKeys(options.secret);
  const ttlMs = options.ttlMs ?? DEFAULT_TAKEOVER_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 60_000) {
    throw new TypeError("A takeover must stay open for at least a minute.");
  }
  return {
    options,
    keys,
    ttlMs,
    port: options.port ?? DEFAULT_TAKEOVER_PORT,
    expose: options.expose ?? vercelSandboxPorts(),
    baseUrl: () => resolveBaseUrl(options.baseUrl),
  };
}

/**
 * What a person takes over. An extension that owns a screen implements one:
 * it readies a stream in the sandbox and says how to reach it.
 */
export interface TakeoverSource {
  /** Shown to the person, such as "browser" or "desktop". */
  readonly label: string;
  /** What the stream speaks, so the viewer can render it. */
  readonly protocol: TakeoverProtocol;
  /**
   * `websocket`: the stream server is a loopback WebSocket server, and the
   * proxy forwards the upgrade. `tcp`: a loopback TCP server, such as VNC, and
   * the proxy bridges WebSocket frames to it.
   */
  readonly upstream: "websocket" | "tcp";
  /**
   * Readies the stream. Returns a shell command that prints the stream's
   * loopback port when the proxy connects, or why there is nothing to share.
   */
  prepare(
    sandbox: TakeoverSandbox,
    signal?: AbortSignal,
  ): Promise<{ readonly portCommand: string } | { readonly unavailable: string }>;
  /** Stops whatever `prepare` started only for the takeover, once control comes back. */
  release?(sandbox: TakeoverSandbox): Promise<void>;
}

export interface OpenTakeoverInput {
  readonly sandbox: TakeoverSandbox;
  readonly sessionId: string;
  readonly callId: string;
  readonly requester: TakeoverRequester | null | undefined;
  readonly source: TakeoverSource;
  readonly task: string;
  /** eve's sign-in callback URL; the viewer opens it when the person presses Done. */
  readonly callbackUrl: string;
  readonly signal?: AbortSignal;
  readonly now?: number;
}

export type OpenTakeoverResult =
  | {
      readonly status: "ready";
      readonly link: string;
      readonly expiresAt: number;
      readonly ttlMs: number;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Readies the source, starts the proxy, exposes its port, and seals a link
 * only the requester can open. Safe to repeat for the same call, as a retried
 * workflow step does: it replaces a running proxy and reuses an exposed port.
 */
export async function openTakeover(
  takeover: Takeover,
  input: OpenTakeoverInput,
): Promise<OpenTakeoverResult> {
  const requester = input.requester;
  if (!requester || requester.principalType !== "user") {
    return { status: "unavailable", reason: "Only a person's own turn can hand over control." };
  }
  const base = takeover.baseUrl();
  if (!base) {
    return {
      status: "unavailable",
      reason: "The agent's public URL is unknown; set baseUrl in defineTakeover.",
    };
  }

  const prepared = await input.source.prepare(input.sandbox, input.signal);
  if ("unavailable" in prepared) return { status: "unavailable", reason: prepared.unavailable };

  await input.sandbox.run({ command: `mkdir -p ${TAKEOVER_DIR} && chmod 700 ${TAKEOVER_DIR}` });
  await input.sandbox.writeTextFile({ path: PROXY_PATH, content: TAKEOVER_PROXY_SOURCE });
  await stopProxy(input.sandbox);
  const started = await input.sandbox.run({
    command: `setsid nohup node ${PROXY_PATH} >/dev/null 2>&1 < /dev/null & echo $! > ${PID_PATH}`,
    env: {
      EVE_TAKEOVER_PORT: String(takeover.port),
      EVE_TAKEOVER_PUBLIC_KEY: takeover.keys.publicKeySpki,
      EVE_TAKEOVER_SESSION_ID: input.sessionId,
      EVE_TAKEOVER_CALL_ID: input.callId,
      EVE_TAKEOVER_UPSTREAM: input.source.upstream,
      EVE_TAKEOVER_PORT_COMMAND: prepared.portCommand,
      EVE_TAKEOVER_TTL_MS: String(takeover.ttlMs),
      EVE_TAKEOVER_MAX_TOKEN_TTL_MS: String(STREAM_TOKEN_MAX_TTL_MS),
      EVE_TAKEOVER_ALLOWED_ORIGIN: new URL(base).origin,
    },
  });
  if (started.exitCode !== 0) {
    return { status: "unavailable", reason: "The takeover proxy couldn't start in the sandbox." };
  }
  const healthy = await input.sandbox.run({ command: waitForHealthCommand(takeover.port) });
  if (healthy.exitCode !== 0) {
    await stopProxy(input.sandbox);
    return { status: "unavailable", reason: "The takeover proxy didn't become ready." };
  }

  let exposed: { readonly url: string };
  try {
    exposed = await takeover.expose.open(input.sandbox, takeover.port, takeover.ttlMs);
  } catch (error) {
    await stopProxy(input.sandbox);
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: `The sandbox port couldn't be exposed: ${detail}` };
  }

  const expiresAt = (input.now ?? Date.now()) + takeover.ttlMs;
  const grant = sealTakeoverGrant(takeover.keys, {
    v: 1,
    sid: input.sessionId,
    cid: input.callId,
    requester: grantRequester(requester),
    stream: toStreamUrl(exposed.url),
    protocol: input.source.protocol,
    label: input.source.label,
    task: input.task,
    callback: input.callbackUrl,
    exp: expiresAt,
  });
  return {
    status: "ready",
    link: new URL(`${TAKEOVER_ROUTE_PREFIX.slice(1)}/${grant}`, base).toString(),
    expiresAt,
    ttlMs: takeover.ttlMs,
  };
}

/** Stops the proxy, unexposes its port, and releases the source. Never throws. */
export async function closeTakeover(
  takeover: Takeover,
  sandbox: TakeoverSandbox,
  source?: TakeoverSource,
): Promise<void> {
  await stopProxy(sandbox).catch(() => undefined);
  await takeover.expose.close(sandbox, takeover.port).catch(() => undefined);
  await source?.release?.(sandbox).catch(() => undefined);
}

/** The requester's identity fields, without anything else the auth context carries. */
function grantRequester(requester: TakeoverRequester): TakeoverRequester {
  const identity: {
    authenticator: string;
    principalType: string;
    principalId: string;
    issuer?: string;
    subject?: string;
    attributes: TakeoverRequester["attributes"];
  } = {
    authenticator: requester.authenticator,
    principalType: requester.principalType,
    principalId: requester.principalId,
    attributes: requester.attributes,
  };
  if (requester.issuer !== undefined) identity.issuer = requester.issuer;
  if (requester.subject !== undefined) identity.subject = requester.subject;
  return identity;
}

/** `https://sb-xyz.vercel.run` -> `wss://sb-xyz.vercel.run/stream`. */
export function toStreamUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("The exposed sandbox URL is not HTTPS.");
  parsed.protocol = "wss:";
  parsed.pathname = "/stream";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function resolveBaseUrl(explicit: string | undefined): string | null {
  const configured = explicit?.trim();
  if (configured) return `${new URL(configured).origin}/`;
  const env = process.env;
  const production = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (env.VERCEL_ENV === "production" && production) return `https://${production}/`;
  const branch = env.VERCEL_BRANCH_URL?.trim() || env.VERCEL_URL?.trim();
  if (branch) return `https://${branch}/`;
  return null;
}

function waitForHealthCommand(port: number): string {
  const script = `const u="http://127.0.0.1:${port}/healthz";for(let i=0;i<50;i++){try{if((await fetch(u)).ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1)`;
  return `node --input-type=module -e '${script}'`;
}

async function stopProxy(sandbox: TakeoverSandbox): Promise<void> {
  // `[e]ve-takeover` keeps pkill from matching the shell that runs it.
  await sandbox.run({
    command: `if [ -f ${PID_PATH} ]; then kill "$(cat ${PID_PATH})" 2>/dev/null || true; rm -f ${PID_PATH}; fi; pkill -f '[e]ve-takeover/proxy.mjs' 2>/dev/null || true`,
  });
}
