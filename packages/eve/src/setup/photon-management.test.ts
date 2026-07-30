import { describe, expect, test, vi } from "vitest";

import {
  provisionPhotonProject,
  usePhotonProject,
  validatePhotonPhoneNumber,
} from "./photon-management.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Photon management provisioning", () => {
  test("authorizes and creates a dedicated project with an operator", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          device_code: "device-code",
          user_code: "ABCD-1234",
          verification_uri_complete: "https://app.photon.codes/device?code=ABCD-1234",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(response({ access_token: "dashboard-token" }))
      .mockResolvedValueOnce(response({ id: "project-id" }))
      .mockResolvedValueOnce(response({ projectSecret: "project-secret" }))
      .mockResolvedValueOnce(
        response({
          succeed: true,
          data: { user: { id: "user-id", assignedPhoneNumber: "+15550000000" } },
        }),
      );
    const onAuthorization = vi.fn();

    await expect(
      provisionPhotonProject({
        projectName: "eve · demo",
        phoneNumber: "+15551234567",
        onAuthorization,
        deps: { fetch, delay: vi.fn(async () => {}) },
      }),
    ).resolves.toMatchObject({
      projectId: "project-id",
      projectSecret: "project-secret",
      assignedPhoneNumber: "+15550000000",
      cleanup: expect.any(Function),
    });

    expect(onAuthorization).toHaveBeenCalledWith({
      userCode: "ABCD-1234",
      verificationUrl: "https://app.photon.codes/device?code=ABCD-1234",
    });
    const projectRequest = fetch.mock.calls[2];
    expect(JSON.parse(String(projectRequest?.[1]?.body))).toMatchObject({
      name: "eve · demo",
      platforms: ["imessage"],
    });
    const userRequest = fetch.mock.calls[4];
    expect(JSON.parse(String(userRequest?.[1]?.body))).toMatchObject({
      phoneNumber: "+15551234567",
    });
  });

  test("uses an existing project without dashboard authorization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ succeed: true, data: { user: { assignedPhoneNumber: "+15550000000" } } }),
    );

    await expect(
      usePhotonProject({
        projectId: "project-id",
        projectSecret: "project-secret",
        phoneNumber: "+15551234567",
        deps: { fetch, delay: vi.fn(async () => {}) },
      }),
    ).resolves.toMatchObject({
      projectId: "project-id",
      projectSecret: "project-secret",
      assignedPhoneNumber: "+15550000000",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  test.each([
    ["+15551234567", null],
    ["+442079460123", null],
    ["+1555123456", "exactly 10 digits"],
    ["+155512345678", "exactly 10 digits"],
    ["15551234567", "E.164"],
    ["+123456", "E.164"],
  ])("validates phone number %s", (phoneNumber, expected) => {
    const result = validatePhotonPhoneNumber(phoneNumber);
    if (expected === null) expect(result).toBeNull();
    else expect(result).toContain(expected);
  });

  test("rejects non-E.164 phone numbers before authorization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      provisionPhotonProject({
        projectName: "eve · demo",
        phoneNumber: "555-1234",
        onAuthorization: vi.fn(),
        deps: { fetch, delay: vi.fn(async () => {}) },
      }),
    ).rejects.toThrow("E.164");
    expect(fetch).not.toHaveBeenCalled();
  });
});
