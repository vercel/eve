"use client";

import { BotIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition, type SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agentNameSchema } from "@/lib/shoppers/agent-name-schema";
import { PreferenceCard, PreferenceRow } from "../../_components/preference-row";
import { updateAgentName } from "../actions";

export function AgentNameForm({ initialName }: { readonly initialName: string }) {
  const [savedName, setSavedName] = useState(initialName);
  const [name, setName] = useState(initialName);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, startSaving] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  function close() {
    setEditing(false);
    setError(undefined);
    edit.current?.focus();
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const parsed = agentNameSchema.safeParse(name);
    if (!parsed.success) {
      setError("Use 1–40 characters, starting with a letter or number.");
      return;
    }
    setError(undefined);
    startSaving(async () => {
      try {
        setSavedName(await updateAgentName(parsed.data));
        close();
      } catch {
        setError("Unable to save the name. Try again.");
      }
    });
  }

  return (
    <PreferenceCard>
      <PreferenceRow
        icon={BotIcon}
        title="Agent name"
        detail={<span aria-live="polite">{savedName}</span>}
        action={
          <Button
            aria-label={editing ? "Cancel editing agent name" : "Edit agent name"}
            aria-expanded={editing}
            aria-controls={editing ? `${id}-editor` : undefined}
            aria-disabled={saving || undefined}
            ref={edit}
            size="lg"
            type="button"
            variant="ghost"
            onClick={() => {
              if (saving) return;
              if (editing) close();
              else {
                setName(savedName);
                setEditing(true);
              }
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
        }
      />
      {editing && (
        <form
          className="space-y-2 border-t border-border py-4"
          id={`${id}-editor`}
          onSubmit={submit}
        >
          <Label htmlFor={`${id}-name`}>Name used in conversation</Label>
          <div className="flex max-w-sm items-center gap-2">
            <Input
              aria-describedby={error ? `${id}-error` : undefined}
              aria-invalid={error ? true : undefined}
              disabled={saving}
              id={`${id}-name`}
              maxLength={40}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setError(undefined);
              }}
              ref={input}
              required
              size="lg"
              value={name}
            />
            <Button
              disabled={saving || name.trim() === savedName}
              size="lg"
              type="submit"
              variant="outline"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
          {error && (
            <p className="type-caption text-destructive" id={`${id}-error`} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </PreferenceCard>
  );
}
