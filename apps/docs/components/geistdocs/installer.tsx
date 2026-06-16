"use client";

import { track } from "@vercel/analytics";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@vercel/geistdocs/components/input-group";
import { Input } from "@vercel/geistdocs/components/input";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const COPY_TIMEOUT = 2000;

interface InstallerProps {
  className?: string;
  command: string;
}

export const Installer = ({ command, className = "w-48" }: InstallerProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    toast.success("Copied to clipboard");
    setCopied(true);

    track("Copied installer command");
    setTimeout(() => {
      setCopied(false);
    }, COPY_TIMEOUT);
  };

  const Icon = copied ? CheckIcon : CopyIcon;

  return (
    <InputGroup
      className="h-10 cursor-pointer bg-background font-mono shadow-none"
      onClick={handleCopy}
    >
      <InputGroupAddon>
        <span className="font-normal text-muted-foreground">$</span>
      </InputGroupAddon>
      <Input
        className={`${className} h-full flex-1 cursor-pointer rounded-none border-0 bg-transparent font-mono shadow-none focus-visible:ring-0 dark:bg-transparent`}
        readOnly
        value={command}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton aria-label="Copy" onClick={handleCopy} size="icon-xs" title="Copy">
          <Icon className="size-3.5" size={14} />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
};
