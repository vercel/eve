import { defineExtension } from "eve/extension";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import {
  deployedSelfModificationConfigSchema,
  type DeployedSelfModificationConfig,
  type ResolvedDeployedSelfModificationConfig,
} from "./config-schema.js";

// Typed as a Standard Schema so the public declaration names eve's own
// config type instead of Zod's.
const config: StandardSchemaV1<
  DeployedSelfModificationConfig,
  ResolvedDeployedSelfModificationConfig
> = deployedSelfModificationConfigSchema;

/** Deployed self-modification mount; independent of the local development extension. */
export default defineExtension({ config });
