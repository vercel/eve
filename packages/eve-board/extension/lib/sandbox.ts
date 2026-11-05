import {
  resolveBoardSettings,
  resolveBoardToken,
  type BoardChannelSettings,
} from "eve/internal/board";
import type { SandboxNetworkPolicy, SandboxNetworkRule } from "eve/sandbox";

type Settings = () => Pick<BoardChannelSettings, "url" | "profile">;

// The routes `vb` calls. Never `/webhooks/*`, which take any token of this project, so the
// board's token there would let the sandbox forge platform events.
const VB_ROUTES = [
  "me",
  "channels",
  "actors",
  "threads",
  "events",
  "messages(/[0-9]+(/(edit|delete|reactions|labels|sync|typing))?)?",
  "links",
  "schedules(/s?[0-9]+/cancel)?",
  "attachments(/uploads)?(/[A-Za-z0-9_-]+)?",
];

/** Options for `rules()`. */
export interface BoardSandboxRulesOptions {
  /** Recorded on the sandbox's posts as `by.session`, such as the eve session's ID. */
  readonly session?: string;
  /**
   * Narrows what the sandbox may do, as the board's `x-board-scope` header: for example
   * `"dev/=read,post,react"`. It never widens what the project's own token may do.
   */
  readonly scope?: string;
}

/** Options for `renew()`. */
export interface BoardSandboxRenewOptions extends BoardSandboxRulesOptions {
  /** The sandbox's other rules, which the installed policy keeps alongside the board's. */
  readonly allow?: Readonly<Record<string, readonly SandboxNetworkRule[]>>;
  /** Install even when the last token installed for this session is still fresh. */
  readonly force?: boolean;
}

/** A sandbox whose network policy can change while it runs, such as a Vercel Sandbox session. */
export interface BoardPolicySandbox {
  setNetworkPolicy(policy: SandboxNetworkPolicy): PromiseLike<void>;
}

/** `vb` in a sandbox, acting on the board as the agent. */
export interface BoardSandbox {
  /** The environment `vb` needs: the board's URL, and a token the rules replace on the way out. */
  env(): Record<string, string>;
  /**
   * Network-policy rules that add a fresh board token, the agent's profile, and the session to
   * `vb`'s requests, so no credential enters the sandbox. Tokens expire, so install the rules
   * again on each turn, for example in a `turn.started` hook, merged with the sandbox's other
   * rules.
   */
  rules(options?: BoardSandboxRulesOptions): Promise<Record<string, readonly SandboxNetworkRule[]>>;
  /**
   * Installs the rules, merged with `allow`, as the sandbox's network policy: always with
   * `force`, otherwise only when the token last installed for this session expires within five
   * minutes. Call it with `force` when a turn starts, and without before each command, so a
   * long turn never runs on an expired token.
   */
  renew(sandbox: BoardPolicySandbox, options?: BoardSandboxRenewOptions): Promise<void>;
}

const RENEW_BEFORE_MS = 5 * 60_000;
const TRACKED_SESSIONS = 1_000;

/** When a JWT expires, or now when it can't tell, so an unreadable token is always replaced. */
function expiresAt(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function defineBoardSandbox(settings: Settings): BoardSandbox {
  // Per instance, so another instance may install once more than it needs to; that's harmless.
  const installed = new Map<string, number>();
  return {
    env: () => ({
      BOARD_TOKEN: "set-by-the-network-policy",
      BOARD_URL: resolveBoardSettings(settings()).url,
    }),
    rules: async (options = {}) => (await boardRules(options)).rules,
    async renew(target, options = {}) {
      const key = options.session ?? "";
      if (options.force !== true && (installed.get(key) ?? 0) - Date.now() > RENEW_BEFORE_MS)
        return;
      const { rules, token } = await boardRules(options);
      await target.setNetworkPolicy({ allow: { ...options.allow, ...rules } });
      installed.delete(key);
      installed.set(key, expiresAt(token));
      if (installed.size > TRACKED_SESSIONS) installed.delete(installed.keys().next().value ?? "");
    },
  };

  async function boardRules(options: BoardSandboxRulesOptions) {
    const { url, profile } = resolveBoardSettings(settings());
    const token = await resolveBoardToken(url);
    const board = new URL(url);
    const mount = board.pathname.replace(/\/+$/u, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const rules: Record<string, readonly SandboxNetworkRule[]> = {
      [board.host]: [
        {
          match: { path: { regex: `^${mount}(/(${VB_ROUTES.join("|")}))?/?$` } },
          transform: [
            {
              headers: {
                authorization: `Bearer ${token}`,
                "x-board-profile": profile,
                ...(process.env.VERCEL === "1" && { "x-vercel-trusted-oidc-idp-token": token }),
                ...(options.session !== undefined && {
                  "x-board-session": options.session.slice(0, 200),
                }),
                ...(options.scope !== undefined && { "x-board-scope": options.scope }),
              },
            },
          ],
        },
      ],
    };
    return { rules, token };
  }
}
