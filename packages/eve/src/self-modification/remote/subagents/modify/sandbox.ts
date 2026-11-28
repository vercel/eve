import selfModification from "../../extension.js";
import { defineDeployedSelfModificationSandbox } from "../../../deployed-sandbox.js";

export default defineDeployedSelfModificationSandbox(selfModification.config);
