"use client";

import { activeTurn } from "eve/events";
import { useEveAgent } from "eve/react";
import { useMemo, useState } from "react";

import {
  DEFAULT_DEVICE,
  deviceContext,
  isDeviceName,
  type DeviceChoice,
  type DeviceName,
} from "../../../agent/lib/devices";
import { hasLiveStream, latestScreen, toActivity, toolParts, type ToolActivity } from "./activity";
import { ApprovalBanner } from "./approval";
import { Chat } from "./chat";
import { Plus } from "./icons";
import { LiveView, type Control } from "./live-view";
import { Button } from "@ui-sdk/react/button";

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

/** Auto mode's pick for a task, from app/api/device/route.ts; the default device if it fails. */
async function chooseDevice(task: string): Promise<DeviceName> {
  try {
    const response = await fetch("/api/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task }),
    });
    const { device } = (await response.json()) as { device?: unknown };
    return isDeviceName(device) ? device : DEFAULT_DEVICE;
  } catch {
    return DEFAULT_DEVICE;
  }
}

export default function Page() {
  const agent = useEveAgent();
  // What the composer's picker shows, and the device the chat runs on once it starts.
  const [choice, setChoice] = useState<DeviceChoice>("auto");
  const [device, setDevice] = useState<DeviceName>(DEFAULT_DEVICE);
  const [deciding, setDeciding] = useState(false);
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

  const send = async (text: string, picked?: DeviceName) => {
    setSelected(undefined);
    let target = device;
    if (!locked) {
      const wanted = picked ?? choice;
      if (wanted === "auto") {
        setDeciding(true);
        target = await chooseDevice(text);
        setDeciding(false);
      } else {
        target = wanted;
      }
      setDevice(target);
      setChoice(target);
    }
    setControl("agent");
    const clientContext = [deviceContext(target), ...(userDrove ? [TAKEOVER_CONTEXT] : [])];
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
      void send(
        "I took over the screen and I'm done. Continue the task from where things are now.",
      );
    else setControl("agent");
  };

  return (
    <main className={`app ${expanded ? "app-expanded" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">eve</span>
          <span aria-hidden="true" className="brand-slash">
            /
          </span>
          <span className="brand-name">Computer use</span>
        </div>
        <div className="topbar-actions">
          <Button
            aria-label="New chat"
            className="icon-button icon-button-tertiary"
            onClick={() => {
              setSelected(undefined);
              setControl("agent");
              setChoice("auto");
              agent.newSession();
            }}
            title="New chat"
          >
            <Plus size={16} />
          </Button>
        </div>
      </header>
      <section className="main">
        <Chat
          busy={busy}
          choice={locked ? device : choice}
          deciding={deciding}
          disabled={agent.status === "resuming" || deciding}
          locked={locked}
          onChoiceChange={setChoice}
          error={agent.error ? agent.error.message : null}
          messages={agent.messages}
          notice={
            expanded ? null : <ApprovalBanner approvals={approvals} inline onRespond={respond} />
          }
          onSelect={(activity) =>
            setSelected((previous) => (previous?.id === activity.id ? undefined : activity))
          }
          onSend={(text, picked) => void send(text, picked)}
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
