import { logError, type Logger } from "#internal/logging.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";
import {
  SLACK_STATUS_KEEPALIVE_REFRESH_INTERVAL_MS,
  startSlackStatusKeepalive,
  stopSlackStatusKeepalive,
} from "#public/channels/slack/status-keepalive.js";
import type { SlackApiResponse } from "#public/channels/slack/api.js";

export interface SlackThreadStatusController {
  clear(): void;
  handleAnchor(ts: string): void;
  refresh(): Promise<number | undefined>;
  resume(): void;
  start(status?: string): Promise<void>;
  suspend(): number | undefined;
}

export function createSlackThreadStatusController(input: {
  readonly channelId: string;
  readonly enabled: boolean;
  readonly getThreadTs: () => string;
  readonly logger: Logger;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
  readonly state?: { statusKeepaliveStatus?: string | null };
}): SlackThreadStatusController {
  const key = (): string | undefined => {
    const threadTs = input.getThreadTs();
    return input.channelId && threadTs ? `${input.channelId}:${threadTs}` : undefined;
  };

  const clear = (): void => {
    const currentKey = key();
    if (currentKey !== undefined) stopSlackStatusKeepalive(currentKey);
    if (input.state !== undefined) input.state.statusKeepaliveStatus = null;
  };

  const setStatus = async (threadTs: string, status: string): Promise<void> => {
    try {
      const body: Record<string, unknown> = {
        channel_id: input.channelId,
        thread_ts: threadTs,
        status,
      };
      if (status.length > 0) body.loading_messages = [status];
      const response = await input.request("assistant.threads.setStatus", body);
      if (response.ok !== true) {
        input.logger.warn("assistant.threads.setStatus returned not-ok", { error: response.error });
      }
    } catch (error) {
      logError(input.logger, "startTyping threw — swallowed", error, {
        channelId: input.channelId,
      });
    }
  };

  return {
    clear,
    handleAnchor() {
      clear();
    },
    async refresh() {
      const status = input.state?.statusKeepaliveStatus;
      const threadTs = input.getThreadTs();
      if (!input.enabled || !status || !input.channelId || !threadTs) return undefined;
      await setStatus(threadTs, status);
      return SLACK_STATUS_KEEPALIVE_REFRESH_INTERVAL_MS;
    },
    resume() {
      const currentKey = key();
      const status = input.state?.statusKeepaliveStatus;
      const threadTs = input.getThreadTs();
      if (!input.enabled || !currentKey || !status || !threadTs) return;
      startSlackStatusKeepalive({
        key: currentKey,
        refresh: (nextStatus) => setStatus(threadTs, nextStatus),
        status,
      });
    },
    async start(status) {
      const threadTs = input.getThreadTs();
      if (!input.channelId || !threadTs) return;
      const normalized = status === undefined ? "" : truncateTypingStatus(status);
      await setStatus(threadTs, normalized);
      if (!normalized || !input.enabled) {
        clear();
        return;
      }
      if (input.state !== undefined) input.state.statusKeepaliveStatus = normalized;
      startSlackStatusKeepalive({
        key: key()!,
        refresh: (nextStatus) => setStatus(threadTs, nextStatus),
        status: normalized,
      });
    },
    suspend() {
      const currentKey = key();
      const status = input.state?.statusKeepaliveStatus;
      if (!input.enabled || !currentKey || !status) return undefined;
      stopSlackStatusKeepalive(currentKey);
      return SLACK_STATUS_KEEPALIVE_REFRESH_INTERVAL_MS;
    },
  };
}
