import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMicrosandboxSandboxBackend } from "#execution/sandbox/bindings/microsandbox.js";
import {
  createMicrosandboxNetworkPlan,
  createTransformBrokerEnvironment,
  serializeMicrosandboxNetworkPolicyJson,
} from "#execution/sandbox/bindings/microsandbox-network.js";
import {
  MICROSANDBOX_DEFAULT_IMAGE,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";

const lifecycleMocks = vi.hoisted(() => ({
  createMicrosandboxHandle: vi.fn(),
  prewarmMicrosandboxTemplate: vi.fn(),
}));

vi.mock("#execution/sandbox/bindings/microsandbox-lifecycle.js", () => lifecycleMocks);

// The microsandbox native bindings ship for macOS (Apple Silicon) and
// glibc Linux only; keep every microsandbox suite off Windows.
const onWindows = process.platform === "win32";

describe.skipIf(onWindows)("createMicrosandboxSandboxBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the stable backend name without loading microsandbox", () => {
    expect(createMicrosandboxSandboxBackend().name).toBe("microsandbox");
  });

  it("defaults to eve's published sandbox runtime image", () => {
    expect(MICROSANDBOX_DEFAULT_IMAGE).toBe("ghcr.io/vercel/eve:latest");
    expect(resolveMicrosandboxOptions(undefined).image).toBe(MICROSANDBOX_DEFAULT_IMAGE);
  });

  it("excludes setup behavior from the template compatibility hash", () => {
    // How the runtime got installed must not invalidate captured
    // templates — only the sandbox-visible options participate.
    const base = resolveMicrosandboxOptions(undefined);
    const noInstall = resolveMicrosandboxOptions({ setup: { autoInstall: false } });
    expect(base.setup.autoInstall).toBe(true);
    expect(noInstall.setup.autoInstall).toBe(false);
  });

  it("adds version-skew guidance to database failures during prewarm", async () => {
    const cause = Object.assign(
      new Error("Migration file of version 'm20260606_000001_named_volume_kinds' is missing"),
      { code: "database" },
    );
    lifecycleMocks.prewarmMicrosandboxTemplate.mockRejectedValueOnce(cause);

    const prewarm = createMicrosandboxSandboxBackend().prewarm?.({
      runtimeContext: { appRoot: "/tmp/eve-app" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await expect(prewarm).rejects.toMatchObject({
      cause,
      message: expect.stringContaining(
        'Failed to prewarm microsandbox template "template-key" [database]: ' +
          "Migration file of version 'm20260606_000001_named_volume_kinds' is missing. " +
          "Check that the microsandbox npm package and installed VM runtime use the same version. " +
          "If versions changed, use a clean MSB_HOME or migrate the existing database.",
      ),
    });
  });
});

describe.skipIf(onWindows)("createMicrosandboxNetworkPlan", () => {
  it("maps allow-all to default egress allow", () => {
    expect(createMicrosandboxNetworkPlan("allow-all")).toEqual({
      disabled: false,
      policy: {
        defaultEgress: "allow",
        defaultIngress: "deny",
        rules: [],
      },
      transformHeaderRules: [],
    });
  });

  it("maps deny-all to disabled networking", () => {
    expect(createMicrosandboxNetworkPlan("deny-all")).toEqual({
      disabled: true,
      policy: null,
      transformHeaderRules: [],
    });
  });

  it("maps domain allow lists and wildcard domains to microsandbox rules", () => {
    const plan = createMicrosandboxNetworkPlan({
      allow: ["api.example.com", "*.npmjs.org"],
    });

    expect(plan.disabled).toBe(false);
    expect(plan.policy).toMatchObject({
      defaultEgress: "deny",
      defaultIngress: "deny",
    });
    expect(plan.policy?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "allow",
          destination: { domain: "api.example.com", kind: "domain" },
          direction: "egress",
        }),
        expect.objectContaining({
          action: "allow",
          destination: { kind: "domainSuffix", suffix: "npmjs.org" },
          direction: "egress",
        }),
      ]),
    );
  });

  it("preserves subnet deny precedence before allow rules", () => {
    const plan = createMicrosandboxNetworkPlan({
      allow: ["example.com"],
      subnets: {
        allow: ["10.0.0.0/8"],
        deny: ["10.1.0.0/16"],
      },
    });

    expect(plan.policy?.rules.slice(0, 2)).toEqual([
      expect.objectContaining({
        action: "deny",
        destination: { cidr: "10.1.0.0/16", kind: "cidr" },
      }),
      expect.objectContaining({
        action: "allow",
        destination: { cidr: "10.0.0.0/8", kind: "cidr" },
      }),
    ]);
  });

  it("extracts Vercel-style header transforms for the local broker path", () => {
    const plan = createMicrosandboxNetworkPlan({
      allow: {
        "github.com": [
          {
            match: { method: ["GET"] },
            transform: [{ headers: { Authorization: "Basic token" } }],
          },
        ],
        "*": [],
      },
    });

    expect(plan.policy?.defaultEgress).toBe("allow");
    expect(plan.transformHeaderRules).toEqual([
      expect.objectContaining({
        domain: "github.com",
        headers: { Authorization: "Basic token" },
        match: { method: ["GET"] },
        placeholderHeaders: {
          Authorization: expect.stringMatching(/^__EVE_MSB_SECRET_[A-Fa-f0-9]{24}__$/u),
        },
      }),
    ]);
  });

  it("keeps brokered header values out of the guest environment", () => {
    const plan = createMicrosandboxNetworkPlan({
      allow: {
        "github.com": [
          {
            transform: [{ headers: { Authorization: "Basic real-secret" } }],
          },
        ],
      },
    });

    expect(createTransformBrokerEnvironment(plan)).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: expect.stringMatching(
        /^Authorization: __EVE_MSB_SECRET_[A-Fa-f0-9]{24}__$/u,
      ),
    });
  });

  it("serializes policy JSON using microsandbox's native snake-case schema", () => {
    const plan = createMicrosandboxNetworkPlan({
      allow: ["api.example.com", "*.npmjs.org"],
      subnets: {
        allow: ["10.0.0.0/8"],
        deny: ["10.1.0.0/16"],
      },
    });

    expect(JSON.parse(serializeMicrosandboxNetworkPolicyJson(plan.policy!))).toEqual({
      default_egress: "deny",
      default_ingress: "deny",
      rules: expect.arrayContaining([
        expect.objectContaining({
          action: "deny",
          destination: { cidr: "10.1.0.0/16" },
        }),
        expect.objectContaining({
          action: "allow",
          destination: { cidr: "10.0.0.0/8" },
        }),
        expect.objectContaining({
          action: "allow",
          destination: "any",
          ports: [{ end: 53, start: 53 }],
          protocols: ["udp", "tcp"],
        }),
        expect.objectContaining({
          action: "allow",
          destination: { domain: "api.example.com" },
        }),
        expect.objectContaining({
          action: "allow",
          destination: { domain_suffix: "npmjs.org" },
        }),
      ]),
    });
  });
});
