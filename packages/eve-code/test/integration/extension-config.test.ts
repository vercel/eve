import assert from "node:assert/strict";
import test from "node:test";

(globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
  "eve-code-extension-config-test";
const { default: extension } = await import("../../extension/extension.ts");

test("accepts no connectors", () => {
  extension({});
  assert.deepEqual(extension.config, {});
});

test("applies firewall defaults independently", () => {
  extension({
    vercel: { connector: "vercel/acme-bot" },
  });
  assert.equal(extension.config.vercel?.delivery, "firewall");
});

test("rejects empty connector names", () => {
  assert.throws(() => extension({ vercel: { connector: "" } }), /Invalid extension config/u);
});

test("rejects retired github config instead of silently ignoring credentials", () => {
  assert.throws(
    // @ts-expect-error GitHub belongs to the git extension.
    () => extension({ github: { connector: "github/acme", org: "acme" } }),
    /Invalid extension config/u,
  );
});
