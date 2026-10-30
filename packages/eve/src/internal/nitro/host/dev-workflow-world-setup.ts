import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { readActiveDevelopmentRuntimeArtifactsSnapshot } from "#internal/nitro/dev-runtime-artifacts.js";
import { normalizeDevelopmentServerClientUrl } from "#internal/nitro/host/dev-server-url.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  createParentDevelopmentWorkflowWorld,
  type ParentDevelopmentWorkflowWorld,
} from "#internal/workflow/development-world-server.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  usesParentDevelopmentWorkflowWorld,
} from "#internal/workflow/development-world-protocol.js";
import {
  createWorkflowDeliverySecret,
  WORKFLOW_DELIVERY_SECRET_ENV,
} from "#internal/workflow/world-delivery-auth.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
const PORT_ENV = "PORT";

export function createDevelopmentWorkflowWorld(input: {
  readonly appRoot: string;
  readonly resume?: boolean;
  readonly preparedHost: PreparedDevelopmentApplicationHost;
  readonly transportSecret: string;
}): ParentDevelopmentWorkflowWorld | undefined {
  // A World that does not resolve to the vendored local package stays inside
  // the worker; the parent only owns the local World, which must survive
  // worker replacement. The predicate is shared with the generated worker
  // plugin so the two sides cannot disagree.
  if (
    !usesParentDevelopmentWorkflowWorld(
      input.preparedHost.compileResult.manifest.config.experimental?.workflow?.world,
    )
  ) {
    if (input.resume)
      throw new Error("--resume is supported only with the built-in local Workflow World.");
    return undefined;
  }
  return createParentDevelopmentWorkflowWorld({
    agentName: input.preparedHost.compileResult.manifest.config.name,
    resume: input.resume,
    appRoot: input.appRoot,
    resolveActiveGenerationId: () => {
      const snapshot = readActiveDevelopmentRuntimeArtifactsSnapshot(input.appRoot);
      if (snapshot === undefined) {
        throw new Error("Development runtime generation is unavailable.");
      }
      return basename(snapshot.snapshotRoot);
    },
    transportSecret: input.transportSecret,
  });
}

/**
 * Publishes the worker transport settings. A World other than the parent's
 * local one runs inside the workers and needs a delivery secret shared by
 * every process on its queue, so unless the developer set one, every local
 * session of the app reads the same generated secret from `.eve/`.
 */
export function installWorkflowTransportEnvironment(input: {
  readonly appRoot: string;
  readonly secret: string;
  readonly workersOwnWorld: boolean;
}): () => void {
  const previousSecret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  const previousAppRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  const previousDeliverySecret = process.env[WORKFLOW_DELIVERY_SECRET_ENV];
  process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = input.secret;
  process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = input.appRoot;
  if (input.workersOwnWorld && !previousDeliverySecret?.trim()) {
    process.env[WORKFLOW_DELIVERY_SECRET_ENV] = readOrCreateDevelopmentDeliverySecret(
      input.appRoot,
    );
  }
  return () => {
    if (previousDeliverySecret === undefined) {
      delete process.env[WORKFLOW_DELIVERY_SECRET_ENV];
    } else {
      process.env[WORKFLOW_DELIVERY_SECRET_ENV] = previousDeliverySecret;
    }
    if (previousSecret === undefined) {
      delete process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
    } else {
      process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = previousSecret;
    }
    if (previousAppRoot === undefined) {
      delete process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
    } else {
      process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = previousAppRoot;
    }
  };
}

/**
 * Lives in the app's `.eve/` rather than the session state directory, which a
 * local `eve eval` moves so it can run beside `eve dev`: both must accept each
 * other's jobs on a shared queue.
 */
function readOrCreateDevelopmentDeliverySecret(appRoot: string): string {
  const path = join(appRoot, ".eve", "workflow-delivery-secret");
  mkdirSync(dirname(path), { recursive: true });
  // Linking a fully written file publishes it atomically, so a session that
  // starts at the same moment reads either nothing or the whole secret.
  const pending = `${path}.${randomUUID()}`;
  writeFileSync(pending, createWorkflowDeliverySecret(), { mode: 0o600 });
  try {
    linkSync(pending, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(pending, { force: true });
  }
  return readFileSync(path, "utf8").trim();
}

export function installWorkflowLocalQueueEnvironment(serverUrl: string): () => void {
  const previousWorkflowLocalBaseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
  const previousPort = process.env[PORT_ENV];
  const url = new URL(normalizeDevelopmentServerClientUrl(serverUrl));

  process.env[WORKFLOW_LOCAL_BASE_URL_ENV] = url.origin;
  if (url.port) {
    process.env[PORT_ENV] = url.port;
  }

  return () => {
    if (previousWorkflowLocalBaseUrl === undefined) {
      delete process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
    } else {
      process.env[WORKFLOW_LOCAL_BASE_URL_ENV] = previousWorkflowLocalBaseUrl;
    }

    if (previousPort === undefined) {
      delete process.env[PORT_ENV];
    } else {
      process.env[PORT_ENV] = previousPort;
    }
  };
}
