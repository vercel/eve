import { nameIs, type SemanticErrorRule } from "../rule.js";

const passThroughMessage = (link: { readonly message: string }) => link.message;

/**
 * Error class names come from eve's own sandbox backends
 * (`execution/sandbox/bindings`). Those classes already author actionable
 * remediation messages at the failure site — where the missing binary or
 * unreachable daemon is actually known — so these rules contribute the
 * stable catalog identity and pass the message through.
 */
export const SANDBOX_RULES: readonly SemanticErrorRule[] = [
  {
    id: "sandbox-docker-cli-missing",
    name: "Docker CLI not found",
    tags: ["sandbox", "config"],
    when: nameIs("DockerUnavailableError"),
    message: passThroughMessage,
  },
  {
    id: "sandbox-docker-daemon-unreachable",
    name: "Docker daemon unreachable",
    tags: ["sandbox", "config"],
    when: nameIs("DockerDaemonUnavailableError"),
    message: passThroughMessage,
  },
  {
    id: "sandbox-provisioning-failed",
    name: "Sandbox provisioning failed",
    tags: ["sandbox"],
    when: nameIs("MicrosandboxDiagnosticError"),
    message: passThroughMessage,
  },
];
