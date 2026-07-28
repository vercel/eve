import type { AddChannelsDeps } from "./boxes/add-channels.js";
import type { ChannelSetupEnvironment } from "./channel-setup-environment.js";
import type { ChannelSetupUi } from "./channel-setup-ui.js";
import type { ChannelKind } from "./scaffold/index.js";
import type { SetupState } from "./state.js";

/** Shared inputs available to a channel-owned setup implementation. */
export interface ChannelSetupContext {
  readonly environment: ChannelSetupEnvironment;
  readonly state: Readonly<SetupState>;
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
  | { readonly kind: "done"; readonly state: SetupState }
  | { readonly kind: "cancelled" };

/** Setup behavior paired with canonical channel catalog metadata. */
export interface ChannelSetupIntegration {
  readonly kind: ChannelKind;
  readonly label: string;
  readonly hint?: string;
  setup(context: ChannelSetupContext): Promise<ChannelSetupResult>;
}
