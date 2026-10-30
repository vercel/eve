"use client";

import { activeTurn } from "eve/events";
import { useEveAgent } from "eve/react";
import { useMemo, useState } from "react";

import {
  DEFAULT_DEVICE,
  DEVICES,
  deviceContext,
  type DeviceName,
} from "../../../agent/lib/devices";
import { hasLiveStream, latestScreen, toActivity, toolParts, type ToolActivity } from "./activity";
import { ApprovalBanner } from "./approval";
import { Chat } from "./chat";
import { AgentIndicator, ChevronDown, Monitor, Plus } from "./icons";
import { LiveView, type Control } from "./live-view";

const TAKEOVER_CONTEXT =
  "The user just operated the screen by hand. Look at the screen before acting; earlier observations may be stale.";

/** The app's own live view route; see app/api/live/route.ts. */
function liveStreamUrl(sessionId: string | undefined, device: DeviceName): string | undefined {
  if (sessionId === undefined || typeof window === "undefined") return undefined;
  const url = new URL("/api/live", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", sessionId);
  url.searchParams.set("device", device);
  return url.toString();
}

export default function Page() {
  const agent = useEveAgent();
  const [device, setDevice] = useState<DeviceName>(DEFAULT_DEVICE);
  const [selected, setSelected] = useState<ToolActivity | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<Control>("agent");
  // The user stopped a running turn to take control, so handing back resumes the task.
  const [interrupted, setInterrupted] = useState(false);
  const [userDrove, setUserDrove] = useState(false);

  const busy = agent.status === "busy" || activeTurn(agent.view) !== undefined;
  const activities = useMemo(
    () => toolParts(agent.messages).map((part) => toActivity(part, agent.view)),
    [agent.messages, agent.view],
  );
  const current = busy
    ? activities.findLast((activity) => activity.state === "running")
    : undefined;
  const approvals = activities.flatMap((activity) =>
    activity.approval ? [activity.approval] : [],
  );
  const respond = (interactionId: string, optionId: string) =>
    void agent.respond([{ interactionId, optionId }]).catch(() => undefined);

  // A chat keeps the device it started on; switching starts a new chat.
  const locked = agent.messages.length > 0;

  const send = (text: string, target: DeviceName = device) => {
    setSelected(undefined);
    if (!locked) setDevice(target);
    setControl("agent");
    const clientContext = [
      deviceContext(locked ? device : target),
      ...(userDrove ? [TAKEOVER_CONTEXT] : []),
    ];
    setUserDrove(false);
    setInterrupted(false);
    void agent.send(text, { clientContext }).catch(() => undefined);
  };

  const takeControl = async () => {
    setSelected(undefined);
    setControl("user");
    setUserDrove(true);
    if (busy) {
      setInterrupted(true);
      await agent.cancel().catch(() => undefined);
    }
  };

  const handBack = () => {
    if (interrupted)
      send("I took over the screen and I'm done. Continue the task from where things are now.");
    else setControl("agent");
  };

  return (
    <main className={`app ${expanded ? "app-expanded" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <AgentIndicator active={busy} size={18} />
          <span className="brand-name">Computer use</span>
          <span className="badge badge-gray badge-sm">eve</span>
        </div>
        <div className="topbar-actions">
          <label
            className="select"
            title={locked ? "Start a new chat to use another device" : DEVICES[device].description}
          >
            <Monitor size={14} />
            <select
              disabled={locked}
              onChange={(event) => setDevice(event.currentTarget.value as DeviceName)}
              value={device}
            >
              {Object.entries(DEVICES).map(([name, option]) => (
                <option key={name} value={name}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown className="select-chevron" size={14} />
          </label>
          <button
            aria-label="New chat"
            className="icon-button icon-button-tertiary"
            onClick={() => {
              setSelected(undefined);
              setControl("agent");
              agent.newSession();
            }}
            title="New chat"
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>
      </header>
      <section className="main">
        <Chat
          busy={busy}
          device={device}
          disabled={agent.status === "resuming"}
          error={agent.error ? agent.error.message : null}
          messages={agent.messages}
          notice={
            expanded ? null : <ApprovalBanner approvals={approvals} inline onRespond={respond} />
          }
          onSelect={(activity) =>
            setSelected((previous) => (previous?.id === activity.id ? undefined : activity))
          }
          onSend={send}
          onStop={() => void agent.cancel().catch(() => undefined)}
          selectedId={selected?.id}
          view={agent.view}
        />
      </section>
      <LiveView
        agentBusy={busy}
        approvals={approvals}
        control={control}
        current={current}
        device={device}
        live={
          hasLiveStream(activities, device)
            ? liveStreamUrl(agent.session?.sessionId, device)
            : undefined
        }
        expanded={expanded}
        onExitReplay={() => setSelected(undefined)}
        onExpandedChange={setExpanded}
        onHandBack={handBack}
        onRespond={respond}
        onTakeControl={() => void takeControl()}
        pinned={selected}
        screen={latestScreen(activities)}
      />
    </main>
  );
}
