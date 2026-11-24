"use client";

import { track } from "@vercel/analytics";
import {
  CommandPromptContent,
  CommandPromptCopy,
  CommandPromptList,
  CommandPromptPrefix,
  CommandPromptRoot,
  CommandPromptSurface,
  CommandPromptTrigger,
  CommandPromptTriggerDivider,
  CommandPromptViewport,
} from "@vercel/geistdocs/components/command-prompt";
import { type JSX, useState } from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { cn } from "@/lib/utils";

const HUMAN_COMMAND = "npx eve@latest init my-agent";
const AGENT_COMMAND = "npx skills add vercel/eve";

export type InstallAudience = "humans" | "agents";

/**
 * Install prompt that toggles between the human-facing `eve init` command and
 * the agent-facing skills command, with a copy-to-clipboard pill.
 */
export const InstallSwitcher = ({
  className,
  source,
  onAudienceChange,
}: {
  className?: string;
  source: "home_hero" | "home_footer";
  onAudienceChange?: (audience: InstallAudience) => void;
}): JSX.Element => {
  const [audience, setAudienceState] = useState<InstallAudience>("humans");
  const setAudience = (next: InstallAudience) => {
    setAudienceState(next);
    onAudienceChange?.(next);
  };

  return (
    <CommandPromptRoot
      className={cn("w-auto items-start", className)}
      value={audience}
      onValueChange={(nextValue) => {
        const next = nextValue === "agents" ? "agents" : "humans";
        track(analyticsEvents.installerCommandSelected, { target: next });
        setAudience(next);
      }}
    >
      <CommandPromptList>
        <CommandPromptTrigger value="humans" onClickCapture={() => setAudience("humans")}>
          For you
        </CommandPromptTrigger>
        <CommandPromptTriggerDivider />
        <CommandPromptTrigger value="agents" onClickCapture={() => setAudience("agents")}>
          For your agent
        </CommandPromptTrigger>
      </CommandPromptList>

      <CommandPromptSurface className="py-2.5">
        <CommandPromptPrefix>$</CommandPromptPrefix>
        <CommandPromptViewport>
          <CommandPromptContent className="py-1" copyValue={HUMAN_COMMAND} value="humans">
            {HUMAN_COMMAND}
          </CommandPromptContent>
          <CommandPromptContent className="py-1" copyValue={AGENT_COMMAND} value="agents">
            {AGENT_COMMAND}
          </CommandPromptContent>
        </CommandPromptViewport>
        <CommandPromptCopy
          onClick={() =>
            track(analyticsEvents.installerCommandCopyClicked, { source, target: audience })
          }
        />
      </CommandPromptSurface>
    </CommandPromptRoot>
  );
};
