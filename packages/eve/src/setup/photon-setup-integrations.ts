import { PHOTON_CHANNEL_SETUP } from "./photon-setup.js";
import type { PhotonSetupIntegration } from "./photon-setup-integration.js";

/** Resolves the Photon setup integration. */
export function photonSetupIntegration(): PhotonSetupIntegration {
  return PHOTON_CHANNEL_SETUP;
}

export { createPhotonSetupUi } from "./photon-setup-ui.js";
