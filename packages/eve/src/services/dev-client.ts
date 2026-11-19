import type { MessageContent } from "#shared/message-content.js";
import type { Answer } from "#shared/input.js";
import { isLocalDevelopmentServerUrl } from "#services/dev-client/local-host.js";
import {
  readDevelopmentRuntimeArtifactsRevision,
  rebuildDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

export interface DevelopmentRuntimeArtifactRefresher {
  clear(): void;

  refresh(input: {
    readonly answers?: readonly Answer[];
    readonly message?: MessageContent;
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void>;

  refreshAfterSourceChange(input: {
    readonly onRuntimeArtifactsChanged?: (
      change: DevelopmentRuntimeArtifactChange,
    ) => void | Promise<void>;
  }): Promise<void>;

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
    readonly answers?: readonly Answer[];
    readonly message?: MessageContent;
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
  readonly answers?: readonly Answer[];
  readonly message?: MessageContent;
}): boolean {
  return input.message !== undefined && (input.answers?.length ?? 0) === 0;
}

export function createDevelopmentRuntimeArtifactRefresher(input: {
  readonly serverUrl: string;
}): DevelopmentRuntimeArtifactRefresher {
  return new LocalDevelopmentRuntimeArtifactRefresher(input);
}
