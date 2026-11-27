import { defineSandbox } from "eve/sandbox";
import { defineSandboxProvider, SandboxSessionGoneError } from "eve/sandbox/provider";

import {
  TASK_CONTAINER_PROVIDER_NAME,
  taskContainerEnvironment,
} from "./lib/container-sandbox.mjs";

const TaskContainerSandbox = defineSandboxProvider({
  name: TASK_CONTAINER_PROVIDER_NAME,
  stateProtocolVersion: 1,
  environment(options) {
    const implementation = taskContainerEnvironment(options);
    return {
      ...implementation,
      async resume(...args) {
        try {
          return await implementation.resume(...args);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            throw new SandboxSessionGoneError("The benchmark task container no longer exists");
          }
          throw error;
        }
      },
    };
  },
});

export const environment = TaskContainerSandbox.environment();
export default defineSandbox(() => environment.open());
