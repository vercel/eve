import { AlertCircleIcon } from "lucide-react";
import { connection } from "next/server";
import { Fragment, Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { StatsForm } from "@/components/stats-form";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { backendJson, type ServiceInfo } from "@/lib/backend";

export const metadata = { title: "Backend · eve Agent with Python" };

export const instant = true;

export default function BackendPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <PageHeader title="Backend">
        The Python service that runs the agent&apos;s tools and the app&apos;s APIs. It has no
        public URL, so only this app and the agent can reach it.
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Service info</CardTitle>
          <CardDescription>Live details from the running FastAPI service.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<ServiceInfoSkeleton />}>
            <ServiceInfoDetails />
          </Suspense>
        </CardContent>
        <CardFooter className="border-t text-xs text-muted-foreground">
          <p>
            Loaded on the server from <code className="font-mono">GET /v1/info</code> through the{" "}
            <code className="font-mono">BACKEND_URL</code> service binding.
          </p>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Try a Python tool: summary statistics</CardTitle>
          <CardDescription>
            Enter a list of numbers to get the count, mean, median, standard deviation, range, and
            quartiles, calculated in Python by the FastAPI service. It&apos;s the same tool the
            agent calls when you ask it for statistics in the chat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatsForm />
        </CardContent>
        <CardFooter className="border-t text-xs text-muted-foreground">
          <p>
            Sent from your browser through{" "}
            <code className="font-mono">/api/backend/tools/stats</code>, the Next.js proxy to
            FastAPI.
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}

/** Fetched per request, so it streams in after the page shell. */
async function ServiceInfoDetails() {
  await connection();

  let info: ServiceInfo;
  try {
    info = await backendJson<ServiceInfo>("/v1/info");
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return (
      <div className="flex items-start gap-3 text-sm text-destructive">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          Could not reach FastAPI: {error}. Locally, run{" "}
          <code className="font-mono text-xs">pnpm dev:all</code> (all services) or{" "}
          <code className="font-mono text-xs">pnpm dev:api</code>.
        </p>
      </div>
    );
  }

  return (
    <dl className={DETAILS_GRID}>
      <dt className="text-muted-foreground">Python</dt>
      <dd className="font-mono">{info.python_version}</dd>
      <dt className="text-muted-foreground">FastAPI</dt>
      <dd className="font-mono">{info.fastapi_version}</dd>
      <dt className="text-muted-foreground">Environment</dt>
      <dd>
        <Badge variant="secondary">{info.environment}</Badge>
      </dd>
      <dt className="text-muted-foreground">Region</dt>
      <dd className="font-mono">{info.region ?? "local"}</dd>
    </dl>
  );
}

const DETAILS_GRID = "grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-2 text-sm";

function ServiceInfoSkeleton() {
  return (
    <dl aria-busy="true" aria-label="Loading service info" className={DETAILS_GRID}>
      {["Python", "FastAPI", "Environment", "Region"].map((label) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="flex h-6 items-center">
            <Skeleton className="h-4 w-24" />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
