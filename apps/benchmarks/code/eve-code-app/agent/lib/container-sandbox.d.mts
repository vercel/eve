import type { SandboxJson, SandboxProviderImplementation } from "eve/sandbox/provider";

export const TASK_CONTAINER_PROVIDER_NAME: "code-bench-container";

export interface TaskContainerOptions {
  readonly root?: string;
  readonly workspaceAlias?: string;
}

export function taskContainerEnvironment(
  options?: TaskContainerOptions,
): SandboxProviderImplementation<object | undefined, SandboxJson, SandboxJson, object>;
