import type { AddChannelsDeps } from "./setup.js";
import type { ChannelSetupEnvironment } from "./environment.js";
import type { ChannelSetupUi } from "./ui.js";
import type { ChannelKind } from "../../scaffold/index.js";
import type { ProjectResolution } from "../../project-resolution.js";

/** Narrow state owned by one channel setup invocation. */
export interface ChannelSetupState {
  readonly projectPath:
    | string
    | { kind: "unresolved"; inPlace: boolean }
    | { kind: "resolved"; inPlace: boolean; path: string };
  readonly project: ProjectResolution;
  readonly channelSelection: ChannelKind[];
  readonly channels: ChannelKind[];
  readonly webScaffolded: boolean;
  readonly slackScaffolded: boolean;
}

/** Shared inputs available to a channel-owned setup implementation. */
export interface ChannelSetupContext {
  readonly environment: ChannelSetupEnvironment;
  readonly state: Readonly<ChannelSetupState>;
  readonly ui: ChannelSetupUi;
  readonly signal?: AbortSignal;
  readonly force?: boolean;
  readonly headless?: boolean;
  readonly presetCreateSlackbot?: boolean;
  readonly presetPortableCredentials?: boolean;
  readonly deps?: AddChannelsDeps;
  /** Registry installation already owns package dependency mutations. */
  readonly skipDependencyMutation?: boolean;
}

/** Structured outcome from a channel-owned setup implementation. */
export type ChannelSetupResult =
  | { readonly kind: "done"; readonly state: ChannelSetupState }
  | { readonly kind: "cancelled" };

/** Setup behavior paired with canonical channel catalog metadata. */
export interface ChannelSetupIntegration {
  readonly kind: ChannelKind;
  readonly label: string;
  readonly hint?: string;
  setup(context: ChannelSetupContext): Promise<ChannelSetupResult>;
}
