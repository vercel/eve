"use client";

import { SiVercel } from "@icons-pack/react-simple-icons";
import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { analyticsEvents } from "@/lib/analytics/events";

interface TemplateActionsProps {
  demoHref?: string;
  deployHref?: string;
  setupPrompt: string;
  template: string;
}

export const TemplateActions = ({
  demoHref,
  deployHref,
  setupPrompt,
  template,
}: TemplateActionsProps) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(setupPrompt);
    track(analyticsEvents.templateSetupCopied, { template });
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="grid gap-2 sm:flex sm:flex-wrap">
      <Button
        className="w-full justify-center font-medium text-background-100! text-label-14 sm:w-52"
        onClick={copyPrompt}
        type="button"
      >
        <span className="flex items-center gap-2">
          {copied ? (
            <>
              <CheckIcon aria-hidden="true" className="size-4" />
              Paste into your agent
            </>
          ) : (
            <>
              <CopyIcon aria-hidden="true" className="size-4" />
              Setup with one prompt
            </>
          )}
        </span>
      </Button>
      {deployHref ? (
        <Button
          asChild
          className="w-full justify-center font-medium text-label-14 sm:w-auto"
          variant="outline"
        >
          <a
            href={deployHref}
            onClick={() => track(analyticsEvents.templateDeployOpened, { template })}
            rel="noopener noreferrer"
            target="_blank"
          >
            <SiVercel aria-hidden="true" className="size-4" />
            Deploy
          </a>
        </Button>
      ) : null}
      {demoHref ? (
        <Button
          asChild
          className="w-full justify-center font-medium text-label-14 sm:w-auto"
          variant="outline"
        >
          <a
            href={demoHref}
            onClick={() => track(analyticsEvents.templateDemoOpened, { template })}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-4" />
            View Demo
          </a>
        </Button>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {copied ? "Setup prompt copied to clipboard." : ""}
      </span>
    </div>
  );
};
