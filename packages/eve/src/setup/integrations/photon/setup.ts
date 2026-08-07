import { defineSetupIntegration } from "../types.js";
import { applyPhotonSetup, preparePhotonSetup } from "./setup-flow.js";

export const PHOTON_SETUP = defineSetupIntegration({
  kind: "photon",
  label: "Photon",
  hint: "Messages through Photon",
  prepare: preparePhotonSetup,
  apply: applyPhotonSetup,
});
