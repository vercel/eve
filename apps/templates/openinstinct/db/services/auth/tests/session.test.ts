/* oxlint-disable vitest/require-mock-type-parameters -- Session lookup needs a deliberately partial Better Auth fixture. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthSession } from "@db/services/auth/session";
import { authSessionFor } from "@tests/helpers/auth-session";

const mocks = vi.hoisted(() => ({ getAuth: vi.fn(), getSession: vi.fn() }));

vi.mock("@db/services/auth", () => ({ getAuth: mocks.getAuth }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuth.mockResolvedValue({
    api: { getSession: mocks.getSession },
  });
});

describe("auth session", () => {
  it("returns only sessions backed by a verified phone number", async () => {
    const verified = authSessionFor({
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    });
    mocks.getSession
      .mockResolvedValueOnce(verified)
      .mockResolvedValueOnce(
        authSessionFor({
          id: "user-2",
          phoneNumber: "+12025550124",
          phoneNumberVerified: false,
        })
      )
      .mockResolvedValueOnce(
        authSessionFor({ id: "user-3", phoneNumberVerified: true })
      )
      .mockResolvedValueOnce(
        authSessionFor({
          id: "user-4",
          phoneNumber: "",
          phoneNumberVerified: true,
        })
      );

    const headers = new Headers();
    await expect(getAuthSession(headers)).resolves.toEqual(verified);
    await expect(getAuthSession(headers)).resolves.toBeNull();
    await expect(getAuthSession(headers)).resolves.toBeNull();
    await expect(getAuthSession(headers)).resolves.toBeNull();
  });
});
