import type { UserContent } from "ai";
import type { InputResponse } from "#runtime/input/types.js";
import { isLocalDevelopmentServerUrl } from "#services/dev-client/local-host.js";
import {
  readDevelopmentRuntimeArtifactsRevision,
  rebuildDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

/**
 * Tracks local dev runtime-artifact revisions so callers can refresh their
 * presentation before delivering the next turn.
 */
export interface DevelopmentRuntimeArtifactRefresher {
  /**
   * Clears the remembered runtime-artifact revision.
   */
  clear(): void;

  /**
   * Refreshes the artifact revision before a normal turn.
   */
  refresh(input: {
    readonly inputResponses?: readonly InputResponse[];
    readonly message?: string | UserContent;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void>;

  /**
   * Forces one rebuild after a local setup action wrote authored source.
   */
  refreshAfterSourceChange(input: {
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void>;

  /**
   * Checks for a runtime-artifact revision change while the UI is idle.
   */
  refreshIdle(input: {
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void>;
}

export interface DevelopmentRuntimeArtifactChange {
  readonly previousRevision: string;
  readonly revision: string;
}

class LocalDevelopmentRuntimeArtifactRefresher implements DevelopmentRuntimeArtifactRefresher {
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
    readonly inputResponses?: readonly InputResponse[];
    readonly message?: string | UserContent;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void> {
    if (!shouldRefreshRuntimeArtifactsForTurn(input)) {
      return;
    }

    await this.#refreshRuntimeArtifacts({ ...input, rebuild: true });
  }

  async refreshIdle(input: {
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void> {
    await this.#refreshRuntimeArtifacts({ ...input, rebuild: false });
  }

  async refreshAfterSourceChange(input: {
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void> {
    await this.#refreshRuntimeArtifacts({
      ...input,
      force: true,
      rebuild: true,
    });
  }

  async #refreshRuntimeArtifacts(input: {
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
    readonly force?: boolean;
    readonly rebuild: boolean;
  }): Promise<void> {
    if (!this.#isLocal) {
      return;
    }

    const revision =
      (input.rebuild
        ? await rebuildDevelopmentRuntimeArtifacts({
            force: input.force,
            serverUrl: this.#serverUrl,
          })
        : undefined) ??
      (await readDevelopmentRuntimeArtifactsRevision({ serverUrl: this.#serverUrl }));
    if (revision === undefined) {
      return;
    }

    const previousRevision = this.#artifactRevision;
    const revisionChanged = previousRevision !== undefined && previousRevision !== revision;
    if (revisionChanged) {
      await input.onRuntimeArtifactsChanged?.({ previousRevision, revision });
    }
    this.#artifactRevision = revision;
  }
}

function shouldRefreshRuntimeArtifactsForTurn(input: {
  readonly inputResponses?: readonly InputResponse[];
  readonly message?: string | UserContent;
}): boolean {
  return input.message !== undefined && (input.inputResponses?.length ?? 0) === 0;
}

/**
 * Creates a revision-aware local dev runtime-artifact refresher.
 */
export function createDevelopmentRuntimeArtifactRefresher(input: {
  readonly serverUrl: string;
}): DevelopmentRuntimeArtifactRefresher {
  return new LocalDevelopmentRuntimeArtifactRefresher(input);
}
