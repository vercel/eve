"use client";

import type { Interaction } from "eve/react";

import { Shield } from "./icons";

interface ApprovalBannerProps {
  readonly approvals: readonly Interaction[];
  readonly onRespond: (interactionId: string, optionId: string) => void;
  /** In the page flow, above the chat composer, instead of over the screen. */
  readonly inline?: boolean;
}

/** Approval requests, shown where the person can see the screen while deciding. */
export function ApprovalBanner({ approvals, onRespond, inline = false }: ApprovalBannerProps) {
  if (approvals.length === 0) return null;
  return (
    <div
      aria-label="Approval needed"
      className={`approvals ${inline ? "approvals-inline" : ""}`}
      role="dialog"
    >
      {approvals.map((request, index) => {
        // Show the decline option first and the approve option as the primary action.
        const options = [...(request.request.options ?? [])].sort((a, b) => rank(a) - rank(b));
        return (
          <div className="approval" key={request.interactionId}>
            <div className="approval-head">
              <span className="approval-icon">
                <Shield size={16} />
              </span>
              <div>
                <h3>{request.request.title ?? "Approve this action?"}</h3>
                <p className="approval-sub">
                  The agent paused before this step
                  {approvals.length > 1 ? ` · ${index + 1} of ${approvals.length}` : ""}.
                </p>
              </div>
            </div>
            <p className="approval-prompt">{request.request.prompt}</p>
            <div className="approval-actions">
              {options.map((option) => (
                <button
                  className={`button button-sm ${isApprove(option) ? "button-primary" : "button-secondary"}`}
                  key={option.id}
                  onClick={() => onRespond(request.interactionId, option.id)}
                  title={option.description}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isApprove(option: { id: string; style?: string }): boolean {
  return option.style === "primary" || option.id === "approve";
}

function rank(option: { id: string; style?: string }): number {
  return isApprove(option) ? 1 : 0;
}
