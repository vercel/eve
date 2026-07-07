import { defineExtension } from "eve/extension";

// gizmo takes no consumer config, so it declares itself with a bare
// defineExtension() — no schema, nothing to bind. The default export is the
// mount handle; consumers mount it with a bare re-export
// (`export { default } from "gizmo-extension"`). Authoring it through
// defineExtension keeps the mounted-extension marker internal to eve.
export default defineExtension();
