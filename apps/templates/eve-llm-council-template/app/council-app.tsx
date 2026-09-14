"use client";

import { MarkdownClient } from "@comark/react";
import { Client, type MessageStreamEvent } from "eve/client";
import { useEveAgent } from "eve/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { councilResultSchema, type CouncilResult, type MemberId } from "../agent/lib/schemas";

const members: ReadonlyArray<{ id: MemberId; label: string; model: string }> = [
  { id: "grok", label: "xAI", model: "Grok 4.5" },
  { id: "claude", label: "Anthropic", model: "Claude Opus 5" },
  { id: "openai", label: "OpenAI", model: "GPT-5.6 Sol" },
  { id: "kimi", label: "Moonshot AI", model: "Kimi K3" },
];

const memberIds = new Set<MemberId>(members.map((member) => member.id));
const tokenFormatter = new Intl.NumberFormat("en", { notation: "compact" });
const costFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 6,
  minimumFractionDigits: 2,
  style: "currency",
});

type Usage = {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
};

type MemberState = {
  response: string;
  status: "waiting" | "running" | "complete" | "error";
  usage: Usage;
};

const initialMembers = (): Record<MemberId, MemberState> => ({
  claude: { response: "", status: "waiting", usage: {} },
  grok: { response: "", status: "waiting", usage: {} },
  kimi: { response: "", status: "waiting", usage: {} },
  openai: { response: "", status: "waiting", usage: {} },
});

export function CouncilApp() {
  const [client] = useState(() => new Client({ host: "" }));
  const completedMembersRef = useRef(new Set<MemberId>());
  const runIdRef = useRef(0);
  const synthesisStartedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [memberState, setMemberState] = useState(initialMembers);
  const [result, setResult] = useState<CouncilResult>();
  const [resultError, setResultError] = useState<string>();
  const [summaryUsage, setSummaryUsage] = useState<Usage>({});

  const streamMember = useCallback(
    async (memberId: MemberId, sessionId: string, runId: number) => {
      const session = client.sessions.attach(sessionId, { streamIndex: 0 });

      try {
        for await (const event of session.stream()) {
          if (runIdRef.current !== runId) return;

          if (event.type === "message.appended") {
            setMemberState((current) => ({
              ...current,
              [memberId]: {
                ...current[memberId],
                response: `${current[memberId].response}${event.data.messageDelta}`,
                status: "running",
              },
            }));
          }

          if (event.type === "message.completed" && event.data.message) {
            setMemberState((current) => ({
              ...current,
              [memberId]: {
                ...current[memberId],
                response: event.data.message,
              },
            }));
          }

          if (event.type === "step.completed" && event.data.usage) {
            const usage = event.data.usage;
            setMemberState((current) => ({
              ...current,
              [memberId]: {
                ...current[memberId],
                usage: mergeUsage(current[memberId].usage, usage),
              },
            }));
          }

          if (event.type === "turn.completed" || event.type === "session.completed") {
            setMemberState((current) => ({
              ...current,
              [memberId]: { ...current[memberId], status: "complete" },
            }));
          }

          if (event.type === "step.failed" || event.type === "turn.failed") {
            setMemberState((current) => ({
              ...current,
              [memberId]: { ...current[memberId], status: "error" },
            }));
          }
        }
      } catch {
        if (runIdRef.current !== runId) return;
        setMemberState((current) => ({
          ...current,
          [memberId]: { ...current[memberId], status: "error" },
        }));
      }
    },
    [client],
  );

  const handleEvent = useCallback(
    (event: MessageStreamEvent) => {
      if (event.type === "subagent.called" && isMemberId(event.data.name)) {
        const memberId = event.data.name;
        setMemberState((current) => ({
          ...current,
          [memberId]: { ...current[memberId], status: "running" },
        }));
        void streamMember(memberId, event.data.childSessionId, runIdRef.current);
      }

      if (event.type === "subagent.completed" && isMemberId(event.data.subagentName)) {
        const memberId = event.data.subagentName;
        completedMembersRef.current.add(memberId);
        synthesisStartedRef.current = completedMembersRef.current.size === members.length;
        setMemberState((current) => ({
          ...current,
          [memberId]: {
            ...current[memberId],
            response: event.data.output || current[memberId].response,
            status: "complete",
          },
        }));
      }

      if (event.type === "step.completed" && event.data.usage && synthesisStartedRef.current) {
        const usage = event.data.usage;
        setSummaryUsage((current) => mergeUsage(current, usage));
      }

      if (event.type === "result.completed") {
        const parsed = councilResultSchema.safeParse(event.data.result);
        if (!parsed.success) {
          setResultError("The judge returned an invalid result. Ask the council again.");
          return;
        }

        setResult(parsed.data);
      }
    },
    [streamMember],
  );

  const agent = useEveAgent({ onEvent: handleEvent });
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const error = resultError ?? agent.error?.message;
  const allMembersComplete = members.every(
    (member) => memberState[member.id].status === "complete",
  );
  const summaryRunning = !result && allMembersComplete && busy;

  const submit = () => {
    const textarea = textareaRef.current;
    if (!textarea || busy) return;
    if (!textarea.reportValidity()) return;

    const message = textarea.value.trim();
    if (message.length === 0) return;

    runIdRef.current += 1;
    completedMembersRef.current.clear();
    synthesisStartedRef.current = false;
    setMemberState(initialMembers());
    setResult(undefined);
    setResultError(undefined);
    setSummaryUsage({});
    agent.reset();
    void agent.send(message, { outputSchema: councilResultSchema });
  };

  return (
    <div className="vbg-report">
      <div className="vbg-shell">
        <a className="vbg-skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="vbg-header vbg-custom-header">
          <div className="vbg-masthead">
            <span className="vbg-identity">
              <span aria-label="Vercel" className="vbg-wordmark" role="img" />
            </span>
          </div>
        </header>
        <main id="main-content">
          <h1 className="vbg-custom-sr-only">eve LLM council</h1>
          <section aria-busy={busy} aria-label="Council response graph" className="vbg-custom-flow">
            {error ? (
              <p className="vbg-custom-status-message" role="alert">
                {error}
              </p>
            ) : null}

            <form
              className="vbg-custom-prompt-node"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label className="vbg-custom-sr-only" htmlFor="council-prompt">
                Ask the council
              </label>
              <textarea
                autoComplete="off"
                disabled={busy}
                id="council-prompt"
                name="prompt"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask the council anything…"
                ref={textareaRef}
                required
                rows={4}
              />
              <div className="vbg-custom-prompt-footer">
                <span>Enter to submit · Shift + Enter for a new line</span>
                <button disabled={busy} type="submit">
                  {busy ? "Council is responding…" : "Ask Council"}
                </button>
              </div>
            </form>

            <Connector direction="out" />

            <div className="vbg-custom-member-list">
              {members.map((member) => (
                <MemberCard key={member.id} member={member} state={memberState[member.id]} />
              ))}
            </div>

            <Connector direction="in" />

            <article
              aria-busy={summaryRunning}
              aria-live="polite"
              className={`vbg-custom-node vbg-custom-summary-node ${
                result ? "vbg-custom-complete" : summaryRunning ? "vbg-custom-running" : ""
              }`}
            >
              <div className="vbg-custom-summary-heading">
                <span className="vbg-custom-node-kicker">Council Summary</span>
                <span aria-hidden="true" className="vbg-custom-status-dot" />
              </div>
              {result ? (
                <>
                  <h2>Answer</h2>
                  <MarkdownResponse markdown={result.summary} />
                  <AgreementScores scores={result.agreementScores} />
                </>
              ) : summaryRunning ? (
                <>
                  <h2>Synthesizing…</h2>
                  <p>
                    The judge is comparing the 4 completed responses.
                    <span aria-hidden="true" className="vbg-custom-elapsed">
                      {" · "}
                      <ElapsedTime />
                    </span>
                  </p>
                </>
              ) : (
                <>
                  <h2>Pending</h2>
                  <p>The synthesis appears after all 4 responses return.</p>
                </>
              )}
              <UsageDetails label="Summary usage" usage={summaryUsage} />
            </article>
          </section>
        </main>
        <footer className="vbg-footer">
          <span aria-label="Vercel" className="vbg-logo" role="img" />
          <span>Built with eve.dev</span>
        </footer>
      </div>
    </div>
  );
}

function ElapsedTime() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <>
      {seconds}s elapsed{seconds >= 30 ? " · taking longer than usual" : ""}
    </>
  );
}

function MemberCard({
  member,
  state,
}: {
  readonly member: (typeof members)[number];
  readonly state: MemberState;
}) {
  const placeholder =
    state.status === "error"
      ? "This model did not complete its response."
      : state.status === "waiting"
        ? "Pending…"
        : "";

  return (
    <article
      aria-busy={state.status === "running"}
      className={`vbg-custom-node vbg-custom-member-node vbg-custom-${state.status}`}
    >
      <div className="vbg-custom-member-heading" translate="no">
        <div>
          <span className="vbg-custom-node-kicker">{member.label}</span>
          <h2 translate="no">{member.model}</h2>
        </div>
        <span aria-hidden="true" className="vbg-custom-status-dot" />
      </div>
      {state.response ? (
        <MarkdownResponse markdown={state.response} streaming={state.status === "running"} />
      ) : (
        <p className="vbg-custom-response-text">{placeholder}</p>
      )}
      <UsageDetails label={`${member.model} usage`} usage={state.usage} />
    </article>
  );
}

function MarkdownResponse({
  markdown,
  streaming = false,
}: {
  readonly markdown: string;
  readonly streaming?: boolean;
}) {
  return (
    <MarkdownClient
      className="vbg-custom-response-text vbg-custom-markdown-response"
      value={markdown}
      streaming={streaming}
    />
  );
}

function AgreementScores({ scores }: { readonly scores: CouncilResult["agreementScores"] }) {
  return (
    <section aria-labelledby="agreement-heading" className="vbg-custom-agreement-scores">
      <h3 id="agreement-heading">Model agreement</h3>
      <dl>
        {members.map((member) => {
          const score = scores[member.id];

          return (
            <div key={member.id}>
              <dt translate="no">{member.model}</dt>
              <dd>
                <meter aria-label={`${score}% agreement`} max={100} min={0} value={score} />
                <span>{score}%</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function UsageDetails({ label, usage }: { readonly label: string; readonly usage: Usage }) {
  return (
    <dl aria-label={label} className="vbg-custom-usage">
      <div>
        <dt>Input</dt>
        <dd>
          {usage.inputTokens === undefined
            ? "-"
            : `${tokenFormatter.format(usage.inputTokens)} tokens`}
        </dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>
          {usage.outputTokens === undefined
            ? "-"
            : `${tokenFormatter.format(usage.outputTokens)} tokens`}
        </dd>
      </div>
      <div>
        <dt>Cost</dt>
        <dd>{usage.costUsd === undefined ? "-" : costFormatter.format(usage.costUsd)}</dd>
      </div>
    </dl>
  );
}

function Connector({ direction }: { readonly direction: "in" | "out" }) {
  const paths = [12.5, 37.5, 62.5, 87.5];

  return (
    <svg
      aria-hidden="true"
      className={`vbg-custom-connector vbg-custom-connector-${direction}`}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      {paths.map((position) => (
        <path
          d={
            direction === "out"
              ? `M 50 0 C 50 55, ${position} 45, ${position} 100`
              : `M ${position} 0 C ${position} 55, 50 45, 50 100`
          }
          key={position}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        className="vbg-custom-mobile-connector"
        d="M 50 0 L 50 100"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function mergeUsage(current: Usage, next: Usage): Usage {
  return {
    costUsd: sumDefined(current.costUsd, next.costUsd),
    inputTokens: sumDefined(current.inputTokens, next.inputTokens),
    outputTokens: sumDefined(current.outputTokens, next.outputTokens),
  };
}

function sumDefined(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined && next === undefined) return undefined;
  return (current ?? 0) + (next ?? 0);
}

function isMemberId(value: string): value is MemberId {
  return memberIds.has(value as MemberId);
}
