"use client";

import { SigmaIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { StatsCard } from "@/app/_components/tool-cards";
import { statsSchema } from "../../../agent/lib/python-tools";

type Result = { ok: true; data: unknown } | { ok: false; error: string };

export function StatsForm() {
  const [input, setInput] = useState("3, 5, 9, 9, 12, 14, 21");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const numbers = input
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);

    if (numbers.length === 0 || numbers.some((n) => !Number.isFinite(n))) {
      setResult({ ok: false, error: "Enter numbers separated by commas or spaces." });
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/backend/tools/stats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numbers }),
      });
      const data: unknown = await response.json();
      setResult(response.ok ? { ok: true, data } : { ok: false, error: JSON.stringify(data) });
    } catch (cause) {
      setResult({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPending(false);
    }
  }

  const stats = result?.ok ? statsSchema.safeParse(result.data) : undefined;

  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={onSubmit}>
        <Input
          aria-label="Numbers"
          className="flex-1 font-mono"
          onChange={(event) => setInput(event.target.value)}
          value={input}
        />
        <Button disabled={pending} type="submit">
          {pending ? <Spinner /> : <SigmaIcon />}
          {pending ? "Computing…" : "Compute"}
        </Button>
      </form>
      {result ? (
        result.ok ? (
          stats?.success ? (
            <StatsCard stats={stats.data} />
          ) : (
            <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs">
              {JSON.stringify(result.data, null, 2)}
            </pre>
          )
        ) : (
          <p className="text-sm text-destructive">{result.error}</p>
        )
      ) : null}
    </div>
  );
}
