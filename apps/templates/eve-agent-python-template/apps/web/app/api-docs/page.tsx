import { AlertCircleIcon } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { SchemaDisplay } from "@/components/ai-elements/schema-display";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { backendJson } from "@/lib/backend";
import { type ApiSection, type OpenApiDocument, toApiSections } from "@/lib/openapi";

export const metadata = { title: "API · eve Agent with Python" };

export const instant = true;

export default function ApiDocsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <PageHeader title="API">
        Generated on each request from the FastAPI service&apos;s{" "}
        <code className="font-mono text-xs">/openapi.json</code>. The service has no public route:
        the web app and the agent reach it through the{" "}
        <code className="font-mono text-xs">BACKEND_URL</code> service binding, and the browser
        through the <code className="font-mono text-xs">/api/backend/*</code> proxy.
      </PageHeader>

      <Suspense fallback={<ApiReferenceSkeleton />}>
        <ApiReference />
      </Suspense>
    </main>
  );
}

/** Fetched per request, so the reference streams in after the page shell. */
async function ApiReference() {
  await connection();

  let doc: OpenApiDocument;
  try {
    doc = await backendJson<OpenApiDocument>("/openapi.json");
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>API reference unavailable</CardTitle>
          <CardDescription>The OpenAPI document could not be loaded.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-start gap-3 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <p>
            Could not reach FastAPI: {error}. Locally, run{" "}
            <code className="font-mono text-xs">pnpm dev:all</code> (all services) or{" "}
            <code className="font-mono text-xs">pnpm dev:api</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {toApiSections(doc).map((section) => (
        <ApiSectionView key={section.tag} section={section} />
      ))}
    </div>
  );
}

function ApiReferenceSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading API reference" className="space-y-3">
      <Skeleton className="h-4 w-14" />
      {[0, 1, 2].map((index) => (
        <div className="space-y-1.5" key={index}>
          <Skeleton className="h-4 w-24" />
          <div className="overflow-hidden rounded-lg border bg-background">
            <div className="flex items-center gap-3 border-b p-4">
              <Skeleton className="h-[22px] w-12" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="p-4">
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ApiSectionView({ section }: { section: ApiSection }) {
  return (
    <section
      className="scroll-mt-[calc(var(--header-height)+1.5rem)] space-y-3"
      id={section.tag}
    >
      <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
        {section.tag}
      </h2>
      {section.endpoints.map((endpoint) => (
        <div className="space-y-1.5" id={endpoint.id} key={endpoint.id}>
          <h3 className="text-sm font-medium">{endpoint.summary}</h3>
          <SchemaDisplay
            description={endpoint.description}
            method={endpoint.method}
            parameters={endpoint.parameters}
            path={endpoint.path}
            requestBody={endpoint.requestBody}
            responseBody={endpoint.responseBody}
          />
        </div>
      ))}
    </section>
  );
}
