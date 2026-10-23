import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { isAgentFeedbackEnabled } from "@/lib/agent-feedback/availability";
import { AgentFeedbackForm, AgentFeedbackFormFallback } from "./agent-feedback-form";

export const metadata: Metadata = {
  title: "Agent Feedback",
  description: "Review and send feedback about your eve experience.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const AgentFeedbackPage = () => (
  <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
    <header className="flex flex-col gap-3">
      <h1 className="text-gray-1000 text-heading-32">Agent feedback</h1>
      <p className="max-w-prose text-pretty text-copy-14 text-gray-900">
        Review a report prepared by your coding agent before deciding whether to send it to the eve
        team. The agent tries to anonymize each report, but remove anything you don't want to
        include. Nothing is sent until you choose to.
      </p>
    </header>
    <Suspense fallback={<AgentFeedbackFormFallback />}>
      <AgentFeedbackFormWithAvailability />
    </Suspense>
  </main>
);

const AgentFeedbackFormWithAvailability = async () => {
  await connection();

  return <AgentFeedbackForm enabled={isAgentFeedbackEnabled()} />;
};

export default AgentFeedbackPage;
