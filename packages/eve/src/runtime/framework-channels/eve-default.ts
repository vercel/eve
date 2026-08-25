import { localDev, placeholderAuth, vercelOidc } from "#public/channels/auth.js";
import { eveChannel, type EveChannel } from "#public/channels/eve.js";

/**
 * The framework default for `channels/eve.ts`: the complete `/eve/v1`
 * surface (session protocol, connection and session callbacks, task input,
 * public health, and agent info) behind the standard auth chain. A
 * zero-argument factory preserves the per-resolution channel lifecycle.
 * An authored `agent/channels/eve.ts` — typically another `eveChannel(...)`
 * call with different auth — replaces this entire surface.
 */
export default function createDefaultEveChannel(): EveChannel {
  return eveChannel({
    auth: [vercelOidc(), localDev(), placeholderAuth()],
  });
}
