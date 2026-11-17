"use client";

import { useParams } from "next/navigation";
import { RunDetail } from "../../../../components/run-detail";

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  return <RunDetail runId={runId} />;
}
