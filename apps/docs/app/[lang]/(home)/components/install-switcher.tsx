"use client";

// TODO: check whether other pages actually use VA
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
import type { JSX } from "react";
import { cn } from "@/lib/utils";

const HUMAN_COMMAND = "npx eve@latest init my-agent";
const AGENT_COMMAND = "npx skills add vercel/eve";

/**
 * Hero install prompt that toggles between the human-facing `eve init` command
 * and the agent-facing skills command, with a copy-to-clipboard pill.
 */
export const InstallSwitcher = ({ className }: { className?: string }): JSX.Element => (
  <CommandPromptRoot
    className={cn("w-auto items-start", className)}
    defaultValue="humans"
    onValueChange={(value) => {
      track("Selected installer command", { target: value });
    }}
  >
    <CommandPromptList>
      <CommandPromptTrigger value="humans">For humans</CommandPromptTrigger>
      <CommandPromptTriggerDivider />
      <CommandPromptTrigger value="agents">For agents</CommandPromptTrigger>
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
      <CommandPromptCopy />
    </CommandPromptSurface>
  </CommandPromptRoot>
);
