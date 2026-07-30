import type { PhotonSetupEnvironment } from "./photon-setup-environment.js";
import type { PhotonSetupUi } from "./photon-setup-ui.js";
import type { ProjectResolution } from "./project-resolution.js";

/** State owned by a Photon setup invocation. */
export interface PhotonSetupState {
  readonly agentName: string;
  readonly project: ProjectResolution;
  readonly projectPath: string;
}

/** Shared inputs available to the Photon setup implementation. */
export interface PhotonSetupContext {
  readonly environment: PhotonSetupEnvironment;
  readonly state: Readonly<PhotonSetupState>;
  readonly ui: PhotonSetupUi;
  readonly signal?: AbortSignal;
  readonly force?: boolean;
  readonly headless?: boolean;
  readonly photonDeps?: import("./photon-setup.js").PhotonSetupDeps;
}

/** Structured outcome from the Photon setup implementation. */
export type PhotonSetupResult =
  | {
      readonly kind: "done";
      readonly state: PhotonSetupState;
      readonly assignedPhoneNumber?: string;
      readonly dashboardUrl: string;
    }
  | { readonly kind: "cancelled" };

/** Guided Photon setup behavior. */
export interface PhotonSetupIntegration {
  readonly kind: "photon";
  readonly label: string;
  readonly hint?: string;
  setup(context: PhotonSetupContext): Promise<PhotonSetupResult>;
}
