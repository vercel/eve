import { nameIs, type SemanticErrorRule } from "../rule.js";

const passThroughMessage = (link: { readonly message: string }) => link.message;
const passThroughHint = (link: { readonly hint?: string }) => link.hint;

/**
 * Error class names come from eve's own sandbox backends —
 * `DockerUnavailableError` / `DockerDaemonUnavailableError` in
 * `execution/sandbox/bindings/docker-cli.ts` and
 * `MicrosandboxDiagnosticError` in
 * `execution/sandbox/bindings/microsandbox-create.ts` — each of which
 * assigns `this.name` explicitly. Those classes already author actionable
 * remediation messages at the failure site — where the missing binary or
 * unreachable daemon is actually known — so these rules contribute the
 * stable catalog identity and pass the message through. Matching is by
 * name string rather than `instanceof` because the harness must not
 * import from `execution/` and the classes survive structured clone as
 * plain shapes.
 */
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
  {
    id: "sandbox-provisioning-failed",
    name: "Sandbox provisioning failed",
    tags: ["sandbox"],
    when: nameIs("MicrosandboxDiagnosticError"),
    message: passThroughMessage,
    hint: passThroughHint,
  },
];
