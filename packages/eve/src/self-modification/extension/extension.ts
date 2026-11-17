import { defineExtension } from "eve/extension";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { SelfModificationExtensionConfig } from "../config.js";
import { selfModificationConfigSchema } from "./config-schema.js";

const config: StandardSchemaV1<SelfModificationExtensionConfig> = selfModificationConfigSchema;

/** Extension mount configured with the same policy as the agent and sandbox. */
export default defineExtension({ config });

export type { SelfModificationExtensionConfig } from "../config.js";
