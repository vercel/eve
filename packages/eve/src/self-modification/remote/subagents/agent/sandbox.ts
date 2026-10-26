import { defineDeployedSelfModificationSandbox } from "../../checkout.js";
import selfModification from "../../extension.js";

export default defineDeployedSelfModificationSandbox(selfModification.config);
