import {
  resolveBoardSettings,
  resolveBoardToken,
  type BoardChannelSettings,
} from "eve/internal/board";
import type { SandboxNetworkRule } from "eve/sandbox";

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
}

export function defineBoardSandbox(settings: Settings): BoardSandbox {
  return {
    env: () => ({
      BOARD_TOKEN: "set-by-the-network-policy",
      BOARD_URL: resolveBoardSettings(settings()).url,
    }),
    async rules(options = {}) {
      const { url, profile } = resolveBoardSettings(settings());
      const token = await resolveBoardToken(url);
      const board = new URL(url);
      const mount = board.pathname.replace(/\/+$/u, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return {
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
    },
  };
}
