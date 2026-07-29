import type { AddCommandOptions } from "#cli/commands/registry.js";

import type { SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

export interface InstallChannelRegistryItemsOptions {
  installItem?: (appRoot: string, item: string, options?: AddCommandOptions) => Promise<void>;
}

/** Installs registry-owned channel dependencies before integration setup runs. */
export function installChannelRegistryItems(
  options: InstallChannelRegistryItemsOptions = {},
): SetupBox<SetupState, undefined, undefined> {
  const installItem =
    options.installItem ??
    (async (appRoot: string, item: string, addOptions?: AddCommandOptions) => {
      const { installOfficialRegistryItem } = await import("#cli/commands/registry.js");
      await installOfficialRegistryItem(appRoot, item, addOptions);
    });
  return {
    id: "install-channel-registry-items",
    shouldRun: (state) => state.channelSelection.length > 0,
    gather: async () => undefined,
    async perform({ state }) {
      if (state.projectPath.kind !== "resolved") {
        throw new Error("Expected a resolved project path before installing channel dependencies.");
      }
      for (const kind of state.channelSelection) {
        await installItem(state.projectPath.path, `channel/${kind}`);
      }
    },
    apply: (state) => state,
  };
}
