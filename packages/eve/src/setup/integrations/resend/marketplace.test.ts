import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  connectResendMarketplaceResource,
  listResendMarketplaceResources,
  listVercelDomains,
  inspectResendMarketplaceResource,
  provisionResendMarketplaceResource,
  waitForResendMarketplaceDomain,
  type ResendMarketplaceDeps,
} from "./marketplace.js";

function capture(stdout: unknown): ResendMarketplaceDeps["captureVercel"] {
  return vi.fn<ResendMarketplaceDeps["captureVercel"]>(async () => ({
    ok: true,
    stdout: JSON.stringify(stdout),
  }));
}

function deps(input: {
  captureVercel?: ResendMarketplaceDeps["captureVercel"];
  runVercelCaptureStdout?: ResendMarketplaceDeps["runVercelCaptureStdout"];
  delay?: ResendMarketplaceDeps["delay"];
}): ResendMarketplaceDeps {
  return {
    captureVercel: input.captureVercel ?? capture({ stores: [] }),
    runVercelCaptureStdout:
      input.runVercelCaptureStdout ?? vi.fn(async () => ({ ok: false, stdout: "" })),
    delay: input.delay ?? vi.fn(async () => {}),
  };
}

describe("Resend Marketplace", () => {
  it("lists only Resend Marketplace resources", async () => {
    const captureVercel = capture({
      stores: [
        {
          id: "store_resend",
          externalResourceId: "example.com",
          name: "resend-agent",
          product: { slug: "resend-email", integrationConfigurationId: "icfg_resend" },
        },
        {
          id: "store_other",
          externalResourceId: "db-1",
          name: "database",
          product: { slug: "postgres" },
        },
        {
          id: "store_blob",
          name: "blob-without-external-id",
          type: "blob",
        },
      ],
    });

    await expect(
      listResendMarketplaceResources({
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: { captureVercel },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "store_resend", externalResourceId: "example.com" }),
    ]);
  });

  it("lists Vercel-owned domains", async () => {
    const captureVercel = capture({
      domains: [{ name: "example.com" }, { name: "another.example" }],
    });

    await expect(
      listVercelDomains({
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: { captureVercel },
      }),
    ).resolves.toEqual(["example.com", "another.example"]);
    expect(captureVercel).toHaveBeenCalledWith(
      ["domains", "list", "--format", "json", "--limit", "100", "--scope", "team"],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("provisions Resend with domain metadata and production connection", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        resource: {
          id: "store_resend",
          name: "resend-agent",
          externalResourceId: "example.com",
        },
        installation: { id: "icfg_resend" },
      }),
    }));

    await provisionResendMarketplaceResource({
      domain: "example.com",
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      project: { orgId: "team", projectId: "project" },
      deps: deps({ runVercelCaptureStdout }),
    });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "integration",
        "add",
        "resend",
        "--metadata",
        "domain=example.com",
        "--metadata",
        "region=us-east-1",
        "--environment",
        "production",
        "--format",
        "json",
        "--scope",
        "team",
      ],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("polls for the resource after Marketplace hands setup to the browser", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({ ok: false, stdout: "" }));
    const captureVercel = vi
      .fn<ResendMarketplaceDeps["captureVercel"]>()
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ stores: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          stores: [
            {
              id: "store_resend",
              externalResourceId: "provider-id",
              name: "resend-agent",
              metadata: { domain: "mail.example.com" },
              product: { slug: "resend-email" },
            },
          ],
        }),
      });
    const delay = vi.fn(async () => {});
    const log = createFakePrompter().prompter.log;

    await expect(
      provisionResendMarketplaceResource({
        domain: "mail.example.com",
        log,
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: deps({ captureVercel, runVercelCaptureStdout, delay }),
        pollIntervalMs: 1,
        pollTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ id: "store_resend" });
    expect(delay).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("safely stop waiting"));
  });

  it("reads live provider status with integration resource inspect", async () => {
    const captureVercel = capture({
      resource: { id: "store_resend", name: "resend-agent", status: "available" },
    });
    await expect(
      inspectResendMarketplaceResource({
        resource: {
          id: "store_resend",
          externalResourceId: "provider-id",
          name: "resend-agent",
          status: "onboarding",
        },
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: { captureVercel },
      }),
    ).resolves.toMatchObject({ status: "available" });
    expect(captureVercel).toHaveBeenCalledWith(
      ["integration", "resource", "inspect", "resend-agent", "--format", "json", "--scope", "team"],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("tracks DNS verification until the live Marketplace resource becomes ready", async () => {
    const captureVercel = capture({
      resource: { id: "store_resend", name: "resend-agent", status: "available" },
    });
    const delay = vi.fn(async () => {});
    const log = createFakePrompter().prompter.log;

    await expect(
      waitForResendMarketplaceDomain({
        resource: {
          id: "store_resend",
          externalResourceId: "provider-id",
          name: "resend-agent",
          status: "onboarding",
          externalResourceStatus: "onboarding",
          metadata: { domain: "mail.example.com" },
          product: { slug: "resend-email" },
        },
        domain: "mail.example.com",
        log,
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: { captureVercel, delay },
        pollIntervalMs: 1,
        pollTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "available" });
    expect(delay).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("configuring DNS"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("safely stop waiting"));
  });

  it("connects an existing resource using the Vercel CLI JSON format flag", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ connected: true }),
    }));
    await connectResendMarketplaceResource({
      resource: {
        id: "store_resend",
        externalResourceId: "provider-id",
        name: "resend-agent",
      },
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      project: { orgId: "team", projectId: "project" },
      deps: { runVercelCaptureStdout },
    });
    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "integration",
        "resource",
        "connect",
        "resend-agent",
        "--environment",
        "production",
        "--yes",
        "--format",
        "json",
        "--scope",
        "team",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
  });

  it("does not reconnect a resource already attached to the linked project", async () => {
    const runVercelCaptureStdout = vi.fn();
    await connectResendMarketplaceResource({
      resource: {
        id: "store_resend",
        externalResourceId: "example.com",
        name: "resend-agent",
        projectsMetadata: [{ projectId: "project", environments: ["production"] }],
      },
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      project: { orgId: "team", projectId: "project" },
      deps: { runVercelCaptureStdout },
    });
    expect(runVercelCaptureStdout).not.toHaveBeenCalled();
  });
});
