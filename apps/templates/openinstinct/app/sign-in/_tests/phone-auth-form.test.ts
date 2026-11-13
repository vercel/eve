import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import {
  PhoneOtpAuthForm,
  phoneOtpErrorMessage,
} from "@app/sign-in/_components/otp-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn<() => void>(),
    replace: vi.fn<(href: string) => void>(),
  }),
}));

const renderForm = (form: ReactElement) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, form)
  );

describe("phone OTP errors", () => {
  it("shows actionable Linq errors", () => {
    expect(
      phoneOtpErrorMessage({
        code: "LINQ_RECIPIENT_NOT_VERIFIED",
        message: "Send a message to the Linq phone number, then try again.",
      })
    ).toBe("Send a message to the Linq phone number, then try again.");
  });

  it("does not expose unrelated server errors", () => {
    expect(
      phoneOtpErrorMessage({
        code: "INTERNAL_SERVER_ERROR",
        message: "database connection string",
      })
    ).toBe("Unable to send a code. Please try again.");
  });

  it("explains and links the required first-time Messages flow", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        linqPhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("First time signing in?");
    expect(html).toContain("Linq requires one message");
    expect(html).toContain("Send any message");
    expect(html).toContain("Return here and select Send code");
    expect(html).toContain('href="sms:+12025550123"');
    expect(html).toContain("Text Linq in Messages");
  });

  it("keeps the required flow visible when the number cannot be resolved", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        linqPhoneNumber: undefined,
      })
    );

    expect(html).toContain("First time signing in?");
    expect(html).toContain("Find the Linq number in Vercel Connect");
    expect(html).not.toContain("sms:");
    const error = phoneOtpErrorMessage({
      code: "LINQ_SENDING_LINE_UNAVAILABLE",
      message:
        "No Linq line is currently eligible. Complete the first-time sign-in steps above or review line health in Linq.",
    });
    expect(error).toContain("first-time sign-in steps above");
    expect(error).not.toContain("button");
  });

  it("does not show Linq setup during local sign-in", () => {
    const html = renderForm(
      createElement(LocalPhoneAuthForm, { callbackUrl: "/" })
    );

    expect(html).not.toContain("First time signing in?");
    expect(html).toContain("Continue");
  });
});
