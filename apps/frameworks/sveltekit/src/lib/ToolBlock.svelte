<script lang="ts">
  import type { EveDynamicToolPart } from "eve/svelte";

  type InputResponses = readonly {
    readonly optionId?: string;
    readonly requestId: string;
    readonly text?: string;
  }[];

  let {
    part,
    canRespond,
    onInputResponses,
  }: {
    part: EveDynamicToolPart;
    canRespond: boolean;
    onInputResponses: (responses: InputResponses) => void | Promise<void>;
  } = $props();

  let userOpen = $state<boolean>();
  let initiallyOpen = $derived(
    part.state === "approval-requested" || part.state === "approval-responded",
  );
  let isOpen = $derived(userOpen ?? initiallyOpen);

  let toolName = $derived(part.toolMetadata?.eve?.name ?? part.toolName);
  let stateLabel = $derived.by(() => {
    const labels: Record<string, string> = {
      "input-streaming": "Pending",
      "input-available": "Running",
      "approval-requested": "Awaiting Approval",
      "approval-responded": "Responded",
      "output-available": "Completed",
      "output-error": "Error",
      "output-denied": "Denied",
    };

    return labels[part.state] ?? part.state;
  });
  let stateColor = $derived.by(() => {
    if (part.state === "output-error" || part.state === "output-denied") {
      return "text-destructive";
    }
    if (part.state === "output-available") return "text-emerald-600";
    if (part.state === "approval-requested") return "text-yellow-600";
    return "text-muted-foreground";
  });

  let inputRequest = $derived(part.toolMetadata?.eve?.inputRequest);
  let inputResponse = $derived(part.toolMetadata?.eve?.inputResponse);
  let selectedOption = $derived(
    inputRequest?.options?.find((option) => option.id === inputResponse?.optionId),
  );
  let formattedInput = $derived(JSON.stringify(part.input, null, 2));
  let formattedOutput = $derived.by(() => {
    if (typeof part.output === "object") return JSON.stringify(part.output, null, 2);
    return String(part.output ?? "");
  });

  function respondWithOption(optionId: string, requestId: string) {
    void onInputResponses([{ optionId, requestId }]);
  }
</script>

<div class="w-full rounded-md border">
  <button
    type="button"
    class="flex w-full items-center justify-between gap-4 p-3"
    onclick={() => {
      userOpen = !isOpen;
    }}
  >
    <div class="flex items-center gap-2">
      <svg
        class="size-4 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
      >
        <path
          d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        />
      </svg>
      <span class="text-sm font-medium">{toolName}</span>
      <span class="rounded-full bg-secondary px-2 py-0.5 text-xs {stateColor}">
        {stateLabel}
      </span>
    </div>
    <svg
      class="size-4 text-muted-foreground transition-transform {isOpen ? 'rotate-180' : ''}"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>

  {#if isOpen}
    <div class="border-t">
      <div class="space-y-2 overflow-hidden p-4">
        <h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Parameters
        </h4>
        <pre class="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">{formattedInput}</pre>
      </div>

      {#if inputRequest}
        <div class="space-y-3 rounded-md border-y border-yellow-500/30 bg-yellow-500/5 p-3">
          <p class="text-sm text-muted-foreground">
            {inputRequest.prompt}
          </p>
          {#if inputResponse}
            <p class="text-sm font-medium">
              Responded:
              {selectedOption?.label ?? inputResponse.text ?? inputResponse.optionId}
            </p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each inputRequest.options ?? [] as option (option.id)}
                <button
                  disabled={!canRespond}
                  type="button"
                  class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 {option.style ===
                  'danger'
                    ? 'bg-destructive text-white hover:bg-destructive/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'}"
                  onclick={() => respondWithOption(option.id, inputRequest.requestId)}
                >
                  {option.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if part.output || part.errorText}
        <div class="space-y-2 p-4">
          <h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {part.errorText ? "Error" : "Result"}
          </h4>
          {#if part.errorText}
            <div class="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
              {part.errorText}
            </div>
          {:else}
            <pre class="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">{formattedOutput}</pre>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
