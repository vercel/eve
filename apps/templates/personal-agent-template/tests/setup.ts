import { beforeEach, vi } from "vitest";
import { computed, ref } from "vue";

// Nuxt auto-imports these in application code; tests run without a Nuxt host.
function autoImports() {
  vi.stubGlobal("ref", ref);
  vi.stubGlobal("computed", computed);
}
autoImports();
beforeEach(autoImports);
