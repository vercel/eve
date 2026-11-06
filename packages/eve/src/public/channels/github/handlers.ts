import { createLogger, logError } from "#internal/logging.js";
import type {
  GitHubChannelConfig,
  GitHubInboundContext,
  GitHubInboundResult,
} from "#public/channels/github/githubChannel.js";

const log = createLogger("github.handlers");

const hookNames = [
  "onComment",
  "onCheckRun",
  "onCheckSuite",
  "onIssue",
  "onPullRequest",
  "onWorkflowRun",
] as const;

type GitHubHookName = (typeof hookNames)[number];

type GitHubHook = (
  ctx: GitHubInboundContext,
  payload: never,
) => GitHubInboundResult | Promise<GitHubInboundResult>;

/**
 * GitHub webhook handlers that an extension or shared module contributes to an app's single
 * {@link githubChannel}, passed in its `handlers` list. `name` identifies the contributor in logs.
 */
export interface GitHubHandlers extends Pick<GitHubChannelConfig, GitHubHookName> {
  readonly name: string;
}

/** Declares a {@link GitHubHandlers} contribution with its hook types checked. */
export function defineGitHubHandlers(handlers: GitHubHandlers): GitHubHandlers {
  return handlers;
}

type ComposedHooks = Pick<GitHubChannelConfig, GitHubHookName> & {
  readonly onComment: NonNullable<GitHubChannelConfig["onComment"]>;
};

/**
 * Fans each GitHub hook out to the channel config's own hook, then each `handlers` entry in list
 * order. Every handler sees the event; a throw is logged and skipped. The first handler to return
 * a result dispatches the turn, and later results are logged and dropped.
 */
export function composeGitHubHooks(
  config: GitHubChannelConfig & { readonly onComment: ComposedHooks["onComment"] },
): ComposedHooks {
  const contributors: readonly GitHubHandlers[] = [
    { ...config, name: "githubChannel" },
    ...(config.handlers ?? []),
  ];
  const composed: Partial<Record<GitHubHookName, GitHubHook>> = {};
  for (const hook of hookNames) {
    const entries = contributors.flatMap((contributor) => {
      const handler = contributor[hook] as GitHubHook | undefined;
      return handler === undefined ? [] : [{ handler, name: contributor.name }];
    });
    if (entries.length === 0) continue;
    composed[hook] = async (ctx, payload) => {
      let dispatcher: string | undefined;
      let chosen: GitHubInboundResult = null;
      for (const entry of entries) {
        let result: GitHubInboundResult;
        try {
          result = await entry.handler(ctx, payload);
        } catch (error) {
          logError(log, `GitHub ${hook} handler "${entry.name}" failed`, error, {
            deliveryId: ctx.delivery.id,
          });
          continue;
        }
        if (result === null || result === undefined) continue;
        if (dispatcher === undefined) {
          dispatcher = entry.name;
          chosen = result;
        } else {
          log.warn(
            `GitHub ${hook} handler "${entry.name}" result dropped; "${dispatcher}" already dispatched`,
            {
              deliveryId: ctx.delivery.id,
            },
          );
        }
      }
      return chosen;
    };
  }
  return composed as ComposedHooks;
}
