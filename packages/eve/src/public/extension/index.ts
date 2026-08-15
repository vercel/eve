/**
 * Authoring helpers for eve extensions — reusable packages mounted into an
 * agent through `agent/extensions/`.
 *
 * @example
 * ```ts
 * import { defineExtension } from "eve/extension";
 * ```
 */

export {
  defineExtension,
  type ExtensionHandle,
  type MountedExtension,
  type NoConfigExtensionHandle,
} from "#public/definitions/extension.js";
