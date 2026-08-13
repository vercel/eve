import type { RemoteAgentDefinition } from "#public/definitions/remote-agent.js";
import {
  normalizeSerializableRemoteAgentConfig,
  type SerializableRemoteAgentConfig,
} from "#runtime/subagents/dynamic-remote-agent-config.js";

export async function normalizeChannelDirectedRemote(
  remote: RemoteAgentDefinition,
): Promise<SerializableRemoteAgentConfig> {
  const config = await normalizeSerializableRemoteAgentConfig({
    message: "Channel routing requires a valid defineRemoteAgent(...) value.",
    value: remote,
  });
  return {
    ...config,
    path: `/${config.path.replace(/^\/+|\/+$/gu, "")}`,
    url: config.url.replace(/\/$/u, ""),
  };
}

export function channelDirectedRemoteIdentity(remote: SerializableRemoteAgentConfig): string {
  return `${remote.url}\n${remote.path}`;
}
