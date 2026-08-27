import { basename } from "node:path";

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

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
const PORT_ENV = "PORT";

export function createDevelopmentWorkflowWorld(input: {
  readonly appRoot: string;
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
    return undefined;
  }
  return createParentDevelopmentWorkflowWorld({
    agentName: input.preparedHost.compileResult.manifest.config.name,
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

export function installWorkflowTransportEnvironment(appRoot: string, secret: string): () => void {
  const previousSecret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  const previousAppRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = secret;
  process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = appRoot;
  return () => {
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
