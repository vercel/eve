import { MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@web/components/ui/button";
import { listBrowserTraces } from "@db/services/browser-traces";
import { requireRequestScope } from "@web/auth/request-scope";
import { TraceHistory } from "./_components/trace-history";

export default async function TasksPage() {
  const scope = await requireRequestScope();
  let initialError: string | undefined;
  let initialPage;
  try {
    initialPage = await listBrowserTraces(scope);
  } catch (error) {
    console.error("Unable to read browser traces", error);
    initialError = "Unable to read the browser trace history.";
  }
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:p-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-2xl">
          <h1 className="type-page-title">Browser traces</h1>
          <p className="type-supporting-body mt-2 text-muted-foreground">
            Every browser assignment the agent has run: the task, its verified
            outcome, how long it took, and the domains it touched.
          </p>
        </div>
        <Button
          nativeButton={false}
          render={<Link href="/chat" />}
          variant="outline"
        >
          Open chat
          <MessageSquareIcon data-icon="inline-end" />
        </Button>
      </header>

      <TraceHistory initialError={initialError} initialPage={initialPage} />
    </div>
  );
}
