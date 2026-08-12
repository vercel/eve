import { ArrowRight, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import type { JSX } from "react";

const TURNS = [
  {
    number: "01",
    person: "Avery starts the thread",
    current: "avery",
    initiator: "avery",
    capability: "Avery's playbook + credentials",
  },
  {
    number: "02",
    person: "Jordan joins with a question",
    current: "jordan",
    initiator: "avery",
    capability: "Jordan's tools + data access",
  },
  {
    number: "03",
    person: "Riley sends the next turn",
    current: "riley",
    initiator: "avery",
    capability: "Riley's policy + OAuth grants",
  },
] as const;

/** Shows how eve keeps session identity stable while resolving each active participant per turn. */
export function MultiplayerTimeline(): JSX.Element {
  return (
    <figure className="not-prose my-8 overflow-hidden rounded-2xl border border-gray-alpha-400 bg-background-100">
      <div className="border-gray-alpha-400 border-b px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono uppercase tracking-[0.1em] text-label-13 text-blue-900">
              One durable session
            </div>
            <div className="mt-1 font-medium text-copy-16 text-gray-1000">
              Identity changes by turn. Context does not reset.
            </div>
          </div>
          <span className="rounded-full border border-gray-alpha-400 bg-background-200 px-3 py-1 text-copy-13 text-gray-900">
            initiator remains Avery
          </span>
        </div>
      </div>

      <ol className="grid list-none gap-0 p-0! lg:grid-cols-3">
        {TURNS.map((turn, index) => (
          <li
            key={turn.number}
            className="relative min-w-0 border-gray-alpha-400 border-b p-5 last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0"
          >
            {index < TURNS.length - 1 ? (
              <span className="absolute top-7 -right-3 z-10 hidden size-6 items-center justify-center rounded-full border border-gray-alpha-400 bg-background-100 text-gray-900 lg:flex">
                <ArrowRight aria-hidden size={13} />
              </span>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-copy-13 text-gray-700">TURN {turn.number}</span>
              <UserRound aria-hidden className="text-gray-900" size={15} />
            </div>
            <div className="mt-3 font-medium text-copy-14 text-gray-1000">{turn.person}</div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-copy-13">
              <dt className="text-gray-700">current</dt>
              <dd className="m-0! font-mono text-gray-1000">{turn.current}</dd>
              <dt className="text-gray-700">initiator</dt>
              <dd className="m-0! font-mono text-gray-1000">{turn.initiator}</dd>
            </dl>
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-blue-100 p-3 text-copy-13 text-blue-900">
              <KeyRound aria-hidden className="mt-0.5 shrink-0" size={14} />
              {turn.capability}
            </div>
          </li>
        ))}
      </ol>

      <div className="grid gap-px bg-gray-alpha-400 sm:grid-cols-2">
        <div className="bg-background-200 p-5 sm:p-6">
          <div className="text-copy-13 font-medium text-gray-1000">Shared-stream multiplayer</div>
          <p className="mt-2 text-copy-14 text-gray-900">
            Several clients can watch, send, queue, and steer. Messages can carry display names.
          </p>
        </div>
        <div className="bg-blue-100 p-5 sm:p-6">
          <div className="flex items-center gap-2 text-copy-13 font-medium text-blue-900">
            <ShieldCheck aria-hidden size={15} /> eve's additional contract
          </div>
          <p className="mt-2 text-copy-14 text-gray-1000">
            The runtime knows which authenticated principal owns this turn, then resolves policy,
            capabilities, and user credentials from that identity.
          </p>
        </div>
      </div>

      <figcaption className="sr-only">
        Three participants take turns in one eve session. The current principal changes on each
        turn, the initiating principal remains Avery, and capabilities resolve for the current
        speaker.
      </figcaption>
    </figure>
  );
}
