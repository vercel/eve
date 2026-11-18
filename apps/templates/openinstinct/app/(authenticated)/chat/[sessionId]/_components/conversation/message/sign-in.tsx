import { type Interaction, signInEnding } from "eve/events";
import {
  CheckCircleIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";

export function SignInPrompt({
  interaction,
}: {
  readonly interaction: Interaction;
}) {
  const { outcome, request, status } = interaction;
  const signIn = request.signIn;
  const displayName = signIn?.displayName ?? signIn?.name ?? "the service";
  const isOpen = status === "open";
  const isConnected = status === "settled" && outcome === "accepted";
  const Icon = isConnected
    ? CheckCircleIcon
    : isOpen
      ? KeyRoundIcon
      : XCircleIcon;
  const instructions = signIn?.instructions;
  const shouldShowInstructions =
    isOpen && instructions !== undefined && instructions !== request.prompt;
  const alertVariant = isConnected
    ? "success"
    : isOpen
      ? "information"
      : "destructive";
  const ending = outcome === undefined ? undefined : signInEnding(outcome);
  const reason =
    interaction.reason === undefined ? "" : ` (${interaction.reason})`;

  return (
    <Alert variant={alertVariant}>
      <Icon />
      <AlertTitle>
        {isOpen
          ? `Connect ${displayName}`
          : isConnected
            ? `${displayName} connected`
            : `${displayName} sign-in ${ending ?? "ended"}`}
      </AlertTitle>
      <AlertDescription>
        <p>
          {isOpen
            ? request.prompt
            : isConnected
              ? `${displayName} connected.`
              : `${displayName} sign-in ${ending ?? "ended"}${reason}.`}
        </p>
        {shouldShowInstructions ? <p>{instructions}</p> : null}
        {isOpen && signIn?.userCode ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>Code</span>
            <Badge variant="outline">
              <code className="type-compact-code">{signIn.userCode}</code>
            </Badge>
          </div>
        ) : null}
        {isOpen && signIn?.url ? (
          <Button
            render={
              <a
                aria-label={`Sign in with ${displayName}`}
                href={signIn.url}
                rel="noreferrer"
                target="_blank"
              />
            }
            size="sm"
          >
            <ExternalLinkIcon />
            Sign in with {displayName}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
