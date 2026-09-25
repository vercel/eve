import assert from "node:assert/strict";
import { test } from "node:test";

import { createCliHarness } from "./index.ts";
import {
  executionPlan,
  packageName,
  validateModel,
  validateOptions,
  type SupportedCliName,
} from "./plan.ts";
import { SecretRedactor } from "./output.ts";

const ctx = {
  model: "deepseek/deepseek-v4",
  installDir: "/installed-agent",
  instructionPath: "/instruction.md",
  taskWorkdir: "/workspace",
  logsDir: "/logs/agent",
};

for (const name of ["pi", "opencode", "codex"] as const) {
  test(`${name} requires a pin and rejects credential-bearing endpoints`, () => {
    for (const version of [
      "",
      "latest",
      "next",
      "^1.2.3",
      "1",
      "1.2",
      "*",
      "1.2.3; echo unsafe",
      "v1.2.3",
      "01.2.3",
    ]) {
      assert.throws(() => createCliHarness(name, { version }), /explicit exact version/);
    }
    assert.equal(createCliHarness(name, { version: "1.2.3-rc.1" }).name, `${name}@1.2.3-rc.1`);
    for (const baseUrl of [
      "https://user:key@example.com/v1",
      "https://example.com/v1?key=secret",
      "https://example.com/#secret",
      "http://example.com",
      "not a URL",
    ]) {
      assert.throws(
        () => createCliHarness(name, { version: "1.2.3", baseUrl }),
        /without credentials/,
      );
    }
  });

  test(`${name} retains full provider-qualified model IDs`, () => {
    for (const model of ["deepseek/deepseek-v4", "openai/gpt-5.6", "openai/acme/served-model"]) {
      const plan = executionPlan(
        name,
        { version: "1.2.3", reasoning: "high" },
        { ...ctx, model },
        "/runtime",
        "--a 'quote'\n$(touch /never)",
      );
      assert.ok(
        plan.args.includes(model) || plan.args.includes(`--model=eve-bench-gateway/${model}`),
      );
      if (name === "pi") {
        assert.equal(plan.stdin, "--a 'quote'\n$(touch /never)");
        assert.ok(!plan.args.includes("--"));
      } else {
        assert.equal(plan.args.at(-1), "--a 'quote'\n$(touch /never)");
        assert.equal(plan.args.at(-2), "--");
      }
      assert.match(plan.config, /https:\/\/ai-gateway.vercel.sh\/v1/);
      assert.ok(
        !JSON.stringify(
          createCliHarness(name, { version: "1.2.3" }).env({ ...ctx, model }),
        ).includes("API_KEY"),
      );
    }
  });
}

test("pi custom models use runtime environment references and explicit thinking capability", () => {
  const plan = executionPlan(
    "pi",
    { version: "0.74.0", reasoning: "high" },
    ctx,
    "/runtime",
    "do it",
  );
  assert.equal(plan.protocol, "chat-completions");
  assert.deepEqual(JSON.parse(plan.config).providers["eve-bench-gateway"], {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiKey: "$AI_GATEWAY_API_KEY",
    api: "openai-completions",
    models: [{ id: ctx.model, reasoning: true }],
  });
  assert.deepEqual(plan.args.slice(0, 4), ["--print", "--mode", "json", "--session-dir"]);
  assert.ok(plan.args.includes("--thinking"));
});

test("OpenCode uses a custom compatible provider, not OpenAI's Responses loader", () => {
  const plan = executionPlan(
    "opencode",
    { version: "1.2.3", reasoning: "high" },
    ctx,
    "/runtime",
    "do it",
  );
  const provider = JSON.parse(plan.config).provider["eve-bench-gateway"];
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(provider.env, ["OPENAI_API_KEY"]);
  assert.equal(provider.options.baseURL, "https://ai-gateway.vercel.sh/v1");
  assert.deepEqual(provider.models[ctx.model].variants, { high: { reasoningEffort: "high" } });
  assert.ok(plan.args.includes("--dangerously-skip-permissions"));
  assert.ok(plan.args.includes("--variant"));
});

test("Codex has env-key auth, a Responses wire API, and no auth.json", () => {
  const plan = executionPlan(
    "codex",
    { version: "0.118.0", reasoning: "high" },
    ctx,
    "/runtime",
    "do it",
  );
  assert.equal(plan.protocol, "responses");
  assert.match(plan.config, /env_key = "AI_GATEWAY_API_KEY"/);
  assert.match(plan.config, /requires_openai_auth = false/);
  assert.match(plan.config, /wire_api = "responses"/);
  assert.doesNotMatch(plan.config, /auth.json/);
  assert.ok(plan.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(plan.args.includes("model_reasoning_effort=high"));
});

test("no reasoning option means no imposed reasoning setting", () => {
  for (const name of ["pi", "opencode", "codex"] as const) {
    const plan = executionPlan(name, { version: "1.2.3" }, ctx, "/runtime", "instruction");
    assert.doesNotMatch(plan.config, /reasoningEffort|model_reasoning_effort|"reasoning"/);
    assert.ok(!plan.args.includes("--variant"));
  }
  assert.throws(() => validateOptions("pi", { version: "1.2.3", reasoning: "max" }), /reasoning/);
  assert.throws(
    () => validateOptions("codex", { version: "1.2.3", reasoning: "off" }),
    /reasoning/,
  );
});

test("package names follow Harbor's pi rename boundary", () => {
  assert.equal(packageName("pi", "0.73.1"), "@mariozechner/pi-coding-agent");
  assert.equal(packageName("pi", "0.74.0-rc.1"), "@mariozechner/pi-coding-agent");
  assert.equal(packageName("pi", "0.74.0"), "@earendil-works/pi-coding-agent");
  assert.equal(packageName("pi", "1.0.0"), "@earendil-works/pi-coding-agent");
  assert.equal(packageName("codex", "0.118.0"), "@openai/codex");
  assert.equal(packageName("opencode", "1.2.3"), "opencode-ai");
});

test("Hermes fails explicitly before installation, without a substitute agent", () => {
  assert.throws(
    () => createCliHarness("hermes", { version: "v2026.7.20" }),
    /Hermes is not supported.*pinned, audited Python\/uv bundle/,
  );
});

test("model validation rejects unqualified IDs and command/control injection", () => {
  for (const model of [
    "gpt-5.6",
    "openai/",
    "openai/gpt\nmodel",
    "openai/$(cmd)",
    "openai/gpt model",
  ]) {
    assert.throws(() => validateModel(model), /full provider-qualified/);
  }
});

test("constructor snapshots options instead of accepting later mutation", () => {
  const options = { version: "1.2.3" };
  const harness = createCliHarness("pi", options);
  options.version = "latest";
  assert.match(harness.env(ctx).EVE_BENCH_CLI_OPTIONS!, /1.2.3/);
});

test("redaction covers every byte boundary including escaped and Unicode secrets", () => {
  for (const secret of ["fake-key-abcdef", 'fake-"key', "fake-秘密"]) {
    for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      const input = Buffer.from(`prefix ${form} suffix ${form}!`);
      for (let split = 0; split <= input.length; split++) {
        const redactor = new SecretRedactor(secret);
        const output =
          redactor.push(input.subarray(0, split)) +
          redactor.push(input.subarray(split)) +
          redactor.finish();
        assert.equal(output, "prefix [REDACTED] suffix [REDACTED]!");
      }
    }
  }
});

// Keep the supported surface explicit in the pure tests, independently of parent wiring.
const supported: SupportedCliName[] = ["pi", "opencode", "codex"];
test("all supported adapters implement the shared Harness contract", () => {
  for (const name of supported) {
    const harness = createCliHarness(name, { version: "1.2.3" });
    assert.equal(typeof harness.prepare, "function");
    assert.match(harness.command({ ...ctx, installDir: "/has space/and'quote" }), /^exec '/);
  }
});
