import { SparklesIcon, XIcon } from "lucide-react";
import type { RefObject } from "react";
import {
  getSubagentStatus,
  type SubagentSession,
} from "@app/_lib/subagent-sessions";
import { Button } from "@web/components/ui/button";
import { agentLabel } from "./presentation";
import { SubagentTrace } from "./trace";
import { useSessionHistory } from "./use-session-history";

export function TracePreview({
  closeButtonRef,
  onClose,
  parentSessionId,
  session,
}: {
  readonly closeButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly parentSessionId: string;
  readonly session: SubagentSession;
}) {
  const history = useSessionHistory(parentSessionId, session.opened);
  const status = getSubagentStatus(history.events, session);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <SparklesIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate type-card-title">
            {agentLabel(session.name)}
          </h2>
          <p className="truncate type-caption text-muted-foreground">
            Full task trace
          </p>
        </div>
        <Button
          aria-label="Close task trace"
          onClick={onClose}
          ref={closeButtonRef}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <SubagentTrace
          events={history.events}
          hasOlder={history.hasOlder}
          isLoading={history.isLoading}
          isLoadingOlder={history.isLoadingOlder}
          loadOlder={history.loadOlder}
          status={status}
          streamError={history.error}
          target={session}
        />
      </div>
    </div>
  );
}
