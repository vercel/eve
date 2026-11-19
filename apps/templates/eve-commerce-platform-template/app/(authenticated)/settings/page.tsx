import { CpuIcon } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { requirePageScope } from "@/lib/auth/next";
import type { AccessScope } from "@/lib/auth/scope";
import { getGatewayModel } from "@/lib/shoppers/model";
import { PreferenceCard, PreferenceRowSkeleton } from "../_components/preference-row";
import { ModelSelector } from "./_components/model-selector";
import { ThemeSelect } from "./_components/theme-select";

export const metadata = { title: "Settings" };

export default async function Page() {
  const scope = await requirePageScope("/settings");

  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-9 py-8 sm:py-12">
      <h1 className="type-page-title">Settings</h1>

      <SettingsSection headingId="model-heading" title="Model">
        <Suspense
          fallback={
            <>
              <span className="sr-only" role="status">
                Loading active model…
              </span>
              <PreferenceRowSkeleton icon={CpuIcon} title="Active model" />
            </>
          }
        >
          <ModelPreference scope={scope} />
        </Suspense>
      </SettingsSection>

      <SettingsSection headingId="appearance-heading" title="Appearance">
        <ThemeSelect />
      </SettingsSection>
    </div>
  );
}

async function ModelPreference({ scope }: { readonly scope: AccessScope }) {
  return <ModelSelector modelId={await getGatewayModel(scope)} />;
}

function SettingsSection({
  children,
  headingId,
  title,
}: {
  readonly children: ReactNode;
  readonly headingId: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 className="type-section-title" id={headingId}>
        {title}
      </h2>
      <PreferenceCard>{children}</PreferenceCard>
    </section>
  );
}
