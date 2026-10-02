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
  const broker = async () => {};
  extension({
    github: { connector: "github/acme-bot", org: "acme", broker },
    vercel: { connector: "vercel/acme-bot" },
  });
  assert.deepEqual(extension.config.github, { connector: "github/acme-bot", org: "acme", broker });
  assert.equal(extension.config.vercel?.delivery, "firewall");
});

test("rejects empty connector names and organizations", () => {
  assert.throws(
    () => extension({ github: { connector: "", org: "", broker: async () => {} } }),
    /Invalid extension config/u,
  );
  assert.throws(() => extension({ vercel: { connector: "" } }), /Invalid extension config/u);
});
