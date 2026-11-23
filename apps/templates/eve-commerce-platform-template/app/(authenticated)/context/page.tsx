import { BotIcon } from "lucide-react";
import { Suspense } from "react";
import { requirePageScope } from "@/lib/auth/next";
import type { AccessScope } from "@/lib/auth/scope";
import { getAgentName } from "@/lib/shoppers/agent-name";
import { readUserProfile } from "@/lib/shoppers/profile";
import { PreferenceCard, PreferenceRowSkeleton } from "../_components/preference-row";
import { AgentNameForm } from "./_components/agent-name-form";
import { PersonalInfoForm, PersonalInfoSkeleton } from "./_components/personal-info-form";

export const metadata = { title: "Personalization" };

export default async function Page() {
  const scope = await requirePageScope("/context");

  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-9 py-8 sm:py-12">
      <h1 className="type-page-title">Personalization</h1>

      <section aria-labelledby="agent-heading" className="space-y-3">
        <h2 className="type-section-title" id="agent-heading">
          Agent
        </h2>
        <Suspense
          fallback={
            <PreferenceCard>
              <span className="sr-only" role="status">
                Loading agent name…
              </span>
              <PreferenceRowSkeleton icon={BotIcon} title="Agent name" />
            </PreferenceCard>
          }
        >
          <AgentPreference scope={scope} />
        </Suspense>
      </section>

      <section aria-labelledby="personal-info-heading" className="space-y-4">
        <div className="space-y-2">
          <h2 className="type-section-title" id="personal-info-heading">
            Personal info
          </h2>
          <p className="type-supporting-body max-w-2xl text-muted-foreground">
            Add only details you want your agent to share with its model when helping you fill out
            forms.
          </p>
        </div>
        <Suspense fallback={<PersonalInfoSkeleton />}>
          <PersonalInfoPreference scope={scope} />
        </Suspense>
      </section>
    </div>
  );
}

async function AgentPreference({ scope }: { readonly scope: AccessScope }) {
  return <AgentNameForm initialName={await getAgentName(scope)} />;
}

async function PersonalInfoPreference({ scope }: { readonly scope: AccessScope }) {
  return <PersonalInfoForm initialProfile={await readUserProfile(scope)} />;
}
