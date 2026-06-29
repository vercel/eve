import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";

import { parseCreatedConnector, setupConnectionConnector } from "./connection-connector.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

const capture = vi.mocked(captureVercel);
const run = vi.mocked(runVercel);
const create = vi.mocked(runVercelCaptureStdout);
const SERVICE = "mcp.linear.app";
const CANONICAL_UID = "mcp.linear.app/linear";
const CANONICAL_NAME = "linear";

function jsonResult(value: unknown) {
  return { ok: true as const, stdout: JSON.stringify(value) };
}

function connectorResult(uid: string, id: string, subject: "app" | "user") {
  return jsonResult({ uid, id, service: SERVICE, supportedSubjectTypes: [subject] });
}

describe("connector response parsing", () => {
  it("rejects created connectors without user support", () => {
    const response = { uid: "linear/acme", id: "scl_1", supportedSubjectTypes: ["user"] };
    expect(parseCreatedConnector(JSON.stringify(response))).toEqual({
      uid: "linear/acme",
      id: "scl_1",
    });
    expect(
      parseCreatedConnector(JSON.stringify({ ...response, supportedSubjectTypes: ["app"] })),
    ).toBeUndefined();
  });
});

describe("setupConnectionConnector", () => {
  let projectRoot: string;

  beforeEach(async () => {
    capture.mockReset();
    run.mockReset();
    create.mockReset();
    projectRoot = await mkdtemp(join(tmpdir(), "eve-connect-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  function options(prompter = createFakePrompter().prompter) {
    return {
      log: prompter.log,
      prompter,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      canonicalConnectorName: CANONICAL_NAME,
      project: { projectId: "prj_1", orgId: "org_1" },
    };
  }

  it("attaches the canonical connector only after confirming user authorization", async () => {
    capture
      .mockResolvedValueOnce(
        jsonResult({ connectors: [{ uid: CANONICAL_UID, id: "scl_canonical" }] }),
      )
      .mockResolvedValueOnce(connectorResult(CANONICAL_UID, "scl_canonical", "user"));
    run.mockResolvedValue(true);

    await expect(setupConnectionConnector(options())).resolves.toEqual({
      kind: "existing",
      connectorUid: CANONICAL_UID,
    });
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["connect", "list", "--service", SERVICE]),
      expect.any(Object),
    );
    expect(capture).toHaveBeenCalledWith(
      ["api", "/v1/connect/connectors/scl_canonical", "--scope", "org_1", "--raw"],
      expect.any(Object),
    );
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      ["connect", "attach", CANONICAL_UID, "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });

  it("finds a canonical connector by name instead of assuming its UID namespace", async () => {
    const canonicalName = "linear";
    const actualUid = "linear/default";
    capture
      .mockResolvedValueOnce(
        jsonResult({ connectors: [{ uid: actualUid, id: "scl_canonical", name: canonicalName }] }),
      )
      .mockResolvedValueOnce(connectorResult(actualUid, "scl_canonical", "user"));
    run.mockResolvedValue(true);

    await expect(
      setupConnectionConnector({ ...options(), canonicalConnectorName: canonicalName }),
    ).resolves.toEqual({
      kind: "existing",
      connectorUid: actualUid,
    });
    expect(run).toHaveBeenCalledWith(
      ["connect", "attach", actualUid, "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });

  it("does not attach an app-only canonical connector", async () => {
    capture
      .mockResolvedValueOnce(
        jsonResult({ connectors: [{ uid: CANONICAL_UID, id: "scl_canonical" }] }),
      )
      .mockResolvedValueOnce(connectorResult(CANONICAL_UID, "scl_canonical", "app"));
    create.mockResolvedValue(connectorResult("linear/linear-2", "scl_created", "user"));
    run.mockResolvedValue(true);
    const fake = createFakePrompter({
      single: () => "create",
      text: (input) => input.defaultValue!,
    });

    await expect(setupConnectionConnector(options(fake.prompter))).resolves.toEqual({
      kind: "created",
      connectorId: "scl_created",
      connectorUid: "linear/linear-2",
    });
    expect(run).not.toHaveBeenCalledWith(
      ["connect", "attach", CANONICAL_UID, "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });

  it("paginates and offers only existing connectors that support user authorization", async () => {
    run.mockResolvedValue(true);
    capture
      .mockResolvedValueOnce(
        jsonResult({
          connectors: [{ uid: "linear/app", id: "scl_app" }],
          cursor: "next_page",
        }),
      )
      .mockResolvedValueOnce(jsonResult({ connectors: [{ uid: "linear/user", id: "scl_user" }] }))
      .mockResolvedValueOnce(connectorResult("linear/app", "scl_app", "app"))
      .mockResolvedValueOnce(connectorResult("linear/user", "scl_user", "user"));
    const answers = ["find", "linear/user"];
    const selectOptions: SingleSelectOptions<PrompterValue>[] = [];
    const fake = createFakePrompter({
      single: (input) => {
        selectOptions.push(input);
        return answers.shift()!;
      },
    });

    await expect(setupConnectionConnector(options(fake.prompter))).resolves.toEqual({
      kind: "existing",
      connectorUid: "linear/user",
    });
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["--next", "next_page"]),
      expect.any(Object),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["--scope", "org_1"]),
      expect.any(Object),
    );
    expect(fake.selectMessages).toEqual([
      "Which connector should linear use?",
      "Select a connector for linear",
    ]);
    expect(selectOptions[0]).toMatchObject({
      hintLayout: "inline",
      notices: [{ tone: "warning", text: `Could not find a connector named ${CANONICAL_NAME}.` }],
    });
    expect(selectOptions[1]).toMatchObject({
      hintLayout: "inline",
      placeholder: "type to search connectors",
      search: true,
    });
  });

  it("removes a created connector when attach fails", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture
      .mockResolvedValueOnce(
        jsonResult({ connectors: [{ uid: CANONICAL_UID, id: "scl_existing", name: "Linear" }] }),
      )
      .mockResolvedValueOnce(connectorResult(CANONICAL_UID, "scl_existing", "user"));
    create.mockResolvedValue(connectorResult("linear/linear-2", "scl_created", "user"));
    const fake = createFakePrompter({
      single: () => "create",
      text: (input) => input.defaultValue!,
    });

    await expect(setupConnectionConnector(options(fake.prompter))).rejects.toThrow(
      "Could not attach linear/linear-2",
    );
    expect(create).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear-2", "-F", "json", "--scope", "org_1"],
      expect.any(Object),
    );
    expect(run).toHaveBeenLastCalledWith(
      ["connect", "remove", "scl_created", "--disconnect-all", "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });

  it("recovers a partially created connector id from CLI progress and removes it", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture.mockResolvedValue(jsonResult({ connectors: [] }));
    create.mockImplementation(async (_args, createOptions) => {
      createOptions.onOutput?.({ stream: "stderr", text: "Connector created: scl_partial" });
      return { ok: false, stdout: "" };
    });
    const fake = createFakePrompter({ single: () => "create", text: () => "acme" });

    await expect(setupConnectionConnector(options(fake.prompter))).rejects.toThrow(
      `Could not create the ${SERVICE} connector`,
    );
    expect(run).toHaveBeenLastCalledWith(
      ["connect", "remove", "scl_partial", "--disconnect-all", "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });
});
