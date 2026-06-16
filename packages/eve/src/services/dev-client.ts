import type { UserContent } from "ai";
import type { ClientSession } from "#client/session.js";
import type { InputResponse } from "#runtime/input/types.js";
import { isLocalDevelopmentServerUrl } from "#services/dev-client/request-headers.js";
import {
  readDevelopmentRuntimeArtifactsRevision,
  rebuildDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

/**
 * Tracks local dev runtime-artifact revisions and starts a fresh session for
 * normal prompts after HMR, while preserving the current session for
 * input-response resumes.
 */
export interface DevelopmentRuntimeArtifactSessionRefresher {
  /**
   * Clears the remembered runtime-artifact revision.
   */
  clear(): void;

  /**
   * Returns the session that should dispatch the next turn.
   */
  refresh(input: {
    readonly createSession: () => ClientSession;
    readonly inputResponses?: readonly InputResponse[];
    readonly message?: string | UserContent;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
    readonly session: ClientSession;
  }): Promise<ClientSession>;

  /**
   * Checks for a runtime-artifact revision change while the UI is idle.
   */
  refreshIdle(input: {
    readonly createSession: () => ClientSession;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
    readonly session: ClientSession;
  }): Promise<ClientSession>;
}

export interface DevelopmentRuntimeArtifactChange {
  readonly previousRevision: string;
  readonly revision: string;
}

class LocalDevelopmentRuntimeArtifactSessionRefresher implements DevelopmentRuntimeArtifactSessionRefresher {
  readonly #isLocal: boolean;
  readonly #serverUrl: string;
  #artifactRevision: string | undefined;

  constructor(input: { readonly serverUrl: string }) {
    this.#isLocal = isLocalDevelopmentServerUrl(input.serverUrl);
    this.#serverUrl = input.serverUrl;
  }

  clear(): void {
    this.#artifactRevision = undefined;
  }

  async refresh(input: {
    readonly createSession: () => ClientSession;
    readonly inputResponses?: readonly InputResponse[];
    readonly message?: string | UserContent;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
    readonly session: ClientSession;
  }): Promise<ClientSession> {
    if (!shouldRefreshRuntimeArtifactsForTurn(input)) {
      return input.session;
    }

    return await this.#refreshSession({ ...input, rebuild: true });
  }

  async refreshIdle(input: {
    readonly createSession: () => ClientSession;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
    readonly session: ClientSession;
  }): Promise<ClientSession> {
    return await this.#refreshSession({ ...input, rebuild: false });
  }

  async #refreshSession(input: {
    readonly createSession: () => ClientSession;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
    readonly rebuild: boolean;
    readonly session: ClientSession;
  }): Promise<ClientSession> {
    if (!this.#isLocal) {
      return input.session;
    }

    const revision =
      (input.rebuild
        ? await rebuildDevelopmentRuntimeArtifacts({ serverUrl: this.#serverUrl })
        : undefined) ??
      (await readDevelopmentRuntimeArtifactsRevision({ serverUrl: this.#serverUrl }));
    if (revision === undefined) {
      return input.session;
    }

    let session = input.session;
    const previousRevision = this.#artifactRevision;
    if (previousRevision !== undefined && previousRevision !== revision) {
      if (session.state.continuationToken !== undefined) {
        session = input.createSession();
      }
      await input.onRuntimeArtifactsChanged?.({ previousRevision, revision });
    }
    this.#artifactRevision = revision;
    return session;
  }
}

function shouldRefreshRuntimeArtifactsForTurn(input: {
  readonly inputResponses?: readonly InputResponse[];
  readonly message?: string | UserContent;
}): boolean {
  return input.message !== undefined && (input.inputResponses?.length ?? 0) === 0;
}

/**
 * Creates a revision-aware local dev session refresher.
 */
export function createDevelopmentRuntimeArtifactSessionRefresher(input: {
  readonly serverUrl: string;
}): DevelopmentRuntimeArtifactSessionRefresher {
  return new LocalDevelopmentRuntimeArtifactSessionRefresher(input);
}
