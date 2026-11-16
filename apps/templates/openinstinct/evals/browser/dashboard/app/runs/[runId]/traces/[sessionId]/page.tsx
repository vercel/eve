import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table";
import { ActivityDurationBreakdown } from "@web/components/browser/activity-duration-breakdown";
import { browserBenchmarkLiveStatusSchema } from "../../../../../../live-status-schema";
import { dashboardEnv } from "../../../../../env";

const identifier = /^[A-Za-z0-9._:-]+$/u;
const traceArtifactSchema = z.object({
  events: z.array(
    z.object({
      at: z.string(),
      detail: z.string(),
      id: z.string(),
      label: z.string(),
      type: z.string(),
    })
  ),
  sessionId: z.string(),
  taskName: z.string(),
  updatedAt: z.string(),
  version: z.literal(1),
});
const nodeErrorSchema = z.object({ code: z.string() });
const routeParametersSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function BenchmarkTracePage({
  params,
}: PageProps<"/runs/[runId]/traces/[sessionId]">) {
  const { runId, sessionId } = routeParametersSchema.parse(await params);
  if (!identifier.test(runId) || !identifier.test(sessionId)) notFound();

  const browserAbRoot = join(
    dashboardEnv.INIT_CWD ?? process.cwd(),
    ".eve",
    "browser-ab"
  );
  const status = await readRunStatus(browserAbRoot, runId);
  if (!status) notFound();
  const match = findTask(status, sessionId);
  if (!match) notFound();
  const trace = await readTrace(browserAbRoot, runId, sessionId);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header>
        <Link
          className="type-caption text-muted-foreground hover:text-foreground"
          href={`/runs/${encodeURIComponent(runId)}`}
        >
          ← Run details
        </Link>
        <h1 className="type-page-title mt-3">{match.task.name}</h1>
        <p className="type-supporting-body mt-1 text-muted-foreground">
          {match.variant} · {sessionId} · {match.task.status}
        </p>
        <div className="mt-4 max-w-4xl">
          <ActivityDurationBreakdown
            durations={match.task.activityDurationsMs}
          />
        </div>
        {match.task.judgeScore !== null ? (
          <div className="mt-4 max-w-4xl border p-3">
            <p className="type-label">
              LLM judge {Math.round(match.task.judgeScore * 100)}%
            </p>
            {match.task.judgeRationale ? (
              <p className="mt-1 type-caption text-muted-foreground">
                {match.task.judgeRationale}
              </p>
            ) : null}
          </div>
        ) : null}
      </header>

      {trace ? (
        <section aria-label="Task trace" className="grid gap-3">
          <div className="flex flex-wrap justify-between gap-2 type-caption text-muted-foreground">
            <span>{trace.events.length} events</span>
            <span>Updated {new Date(trace.updatedAt).toLocaleString()}</span>
          </div>
          <div className="overflow-hidden border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[14%]">Time</TableHead>
                  <TableHead className="w-[20%]">Event</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trace.events.map((event) => (
                  <TableRow className="border-b border-border" key={event.id}>
                    <TableCell className="type-compact-code align-top text-muted-foreground">
                      {new Date(event.at).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="align-top font-medium whitespace-normal">
                      {event.label}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <pre className="type-compact-code max-h-48 overflow-auto break-all whitespace-pre-wrap text-muted-foreground">
                        {event.detail || "—"}
                      </pre>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : (
        <div className="border p-4">
          <p className="type-supporting-body">
            This is the exact worker session for the task, but detailed events
            were not persisted by this older benchmark run.
          </p>
          <p className="mt-1 type-caption text-muted-foreground">
            New runs save the trace here while the task is active and retain it
            after the ephemeral variant server is removed.
          </p>
        </div>
      )}
    </main>
  );
}

async function readRunStatus(root: string, runId: string) {
  const archived = await readParsedFile(
    join(root, runId, "status.json"),
    browserBenchmarkLiveStatusSchema
  );
  if (archived) return archived;
  const live = await readParsedFile(
    join(root, "live.json"),
    browserBenchmarkLiveStatusSchema
  );
  if (!live) return null;
  return live.runId === runId ? live : null;
}

async function readTrace(root: string, runId: string, sessionId: string) {
  return readParsedFile(
    join(root, runId, "traces", `${sessionId}.json`),
    traceArtifactSchema
  );
}

async function readParsedFile<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema
) {
  try {
    return schema.parse(
      JSON.parse(await readFile(/* turbopackIgnore: true */ path, "utf8"))
    );
  } catch (error) {
    const parsed = nodeErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return null;
    throw error;
  }
}

function findTask(
  status: z.infer<typeof browserBenchmarkLiveStatusSchema>,
  sessionId: string
) {
  for (const variant of [status.variants.baseline, status.variants.candidate]) {
    const task = variant.tasks.find((candidate) =>
      candidate.sessions.some((session) => session.id === sessionId)
    );
    if (task) return { task, variant: variant.kind };
  }
  return null;
}
