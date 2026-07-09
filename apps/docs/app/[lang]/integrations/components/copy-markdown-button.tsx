"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context and user activation; fall back to
    // the legacy selection-based copy.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
};

/** Copies the page's markdown rendition; pairs with `/integrations/<slug>.md`. */
export const CopyMarkdownButton = ({ markdown }: { markdown: string }) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-gray-900 text-sm transition-colors hover:bg-gray-100 hover:text-gray-1000"
      onClick={async () => {
        await copyText(markdown);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      type="button"
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {copied ? "Copied" : "Copy Markdown"}
    </button>
  );
};
