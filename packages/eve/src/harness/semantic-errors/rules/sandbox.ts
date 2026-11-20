import { nameIs, type SemanticErrorRule } from "../rule.js";

const passThroughMessage = (link: { readonly message: string }) => link.message;
const passThroughHint = (link: { readonly hint?: string }) => link.hint;

export const SANDBOX_RULES: readonly SemanticErrorRule[] = [
  {
    id: "sandbox-docker-cli-missing",
    name: "Docker CLI not found",
    tags: ["sandbox", "config"],
    when: nameIs("DockerUnavailableError"),
    message: passThroughMessage,
    hint: passThroughHint,
  },
  {
    id: "sandbox-docker-daemon-unreachable",
    name: "Docker daemon unreachable",
    tags: ["sandbox", "config"],
    when: nameIs("DockerDaemonUnavailableError"),
    message: passThroughMessage,
    hint: passThroughHint,
  },
];
