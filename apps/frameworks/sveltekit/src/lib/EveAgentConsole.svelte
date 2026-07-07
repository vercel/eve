<script lang="ts">
  import { tick } from "svelte";
  import { useEveAgent, type EveMessagePart } from "eve/svelte";

  import ReasoningBlock from "$lib/ReasoningBlock.svelte";
  import StatusDot from "$lib/StatusDot.svelte";
  import ToolBlock from "$lib/ToolBlock.svelte";

  const agent = useEveAgent();

  type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

  let isBusy = $derived(agent.status === "submitted" || agent.status === "streaming");
  let isEmpty = $derived(agent.data.messages.length === 0);

  let messagesEl = $state<HTMLDivElement>();
  let isNearBottom = $state(true);
  const SCROLL_THRESHOLD = 64;

  function onMessagesScroll() {
    if (!messagesEl) return;
    isNearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < SCROLL_THRESHOLD;
  }

  $effect(() => {
    const messageCount = agent.data.messages.length;

    if (!isNearBottom || messageCount === 0) return;

    void tick().then(() => {
      const el = messagesEl;
      if (!el) return;

      el.scrollTo({
        top: el.scrollHeight,
        behavior: "smooth",
      });
    });
  });

  let messageText = $state("");

  function submitMessage() {
    const text = messageText.trim();
    if (!text || isBusy) return;
    messageText = "";
    void agent.send({ message: text });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  }

  function handleInputResponses(
    responses: readonly {
      readonly optionId?: string;
      readonly requestId: string;
      readonly text?: string;
    }[],
  ) {
    void agent.send({ inputResponses: responses });
  }

  function partKey(part: EveMessagePart, index: number): string {
    if (part.type === "dynamic-tool") return part.toolCallId;
    return `${part.type}:${index}`;
  }

  function fileLabel(part: EveFilePart): string {
    return part.filename ?? "Attachment";
  }

  function fileDetail(part: EveFilePart): string {
    return [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  }

  function isImageFile(part: EveFilePart): boolean {
    return part.url !== undefined && part.mediaType.startsWith("image/");
  }

  function formatBytes(size: number | undefined): string | undefined {
    if (size === undefined) return undefined;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<main class="flex min-h-dvh flex-col bg-background text-foreground">
  <header class="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur">
    <div class="mx-auto flex h-12 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
      <div class="flex items-center gap-2 font-mono text-[13px] tracking-tight">
        <span class="font-medium">eve</span>
        <span class="text-muted-foreground">/</span>
        <span class="text-muted-foreground">agent</span>
      </div>
      <StatusDot status={agent.status} />
    </div>
  </header>

  <section class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
    {#if agent.error}
      <div
        class="mt-4 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
      >
        <div>
          <p class="font-medium">Request failed</p>
          <p class="mt-0.5 text-muted-foreground">
            {agent.error.message}
          </p>
        </div>
      </div>
    {/if}

    {#if isEmpty}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <h1 class="text-xl font-medium tracking-tight">eve Agent</h1>
        <p class="max-w-sm text-sm text-muted-foreground">
          Ask for the weather in Vienna, or tell the agent to explain the tools it called.
        </p>
      </div>
    {:else}
      <div
        bind:this={messagesEl}
        class="-mx-4 flex-1 overflow-y-auto sm:-mx-6"
        onscroll={onMessagesScroll}
      >
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
          {#each agent.data.messages as message (message.id)}
            <div
              class="flex w-full gap-2 {message.role === 'user'
                ? 'ml-auto justify-end'
                : 'justify-start'}"
              data-optimistic={message.metadata?.optimistic ? "true" : undefined}
            >
              <div
                class="flex w-fit flex-col gap-2 text-sm {message.role === 'user'
                  ? 'ml-auto rounded-lg bg-secondary px-4 py-3 text-foreground'
                  : 'w-full text-foreground'} {message.metadata?.optimistic ? 'opacity-70' : ''}"
              >
                {#each message.parts as part, index (partKey(part, index))}
                  {#if part.type === "text"}
                    <div class="whitespace-pre-wrap">{part.text}</div>
                  {:else if part.type === "reasoning"}
                    <ReasoningBlock text={part.text} isStreaming={part.state === "streaming"} />
                  {:else if part.type === "file"}
                    {#if part.url}
                      <a
                        href={part.url}
                        target="_blank"
                        rel="noreferrer"
                        class="flex max-w-sm items-center gap-3 rounded-md border border-border/80 bg-background/60 p-2"
                      >
                        {#if isImageFile(part)}
                          <img
                            src={part.url}
                            alt={fileLabel(part)}
                            class="size-12 shrink-0 rounded-sm object-cover"
                          />
                        {:else}
                          <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground"
                          >
                            <svg
                              class="size-4"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              viewBox="0 0 24 24"
                            >
                              <path
                                d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
                              />
                              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                            </svg>
                          </span>
                        {/if}
                        <span class="min-w-0 flex-1">
                          <span class="block truncate font-medium">{fileLabel(part)}</span>
                          {#if fileDetail(part)}
                            <span class="block truncate text-muted-foreground">
                              {fileDetail(part)}
                            </span>
                          {/if}
                        </span>
                      </a>
                    {:else}
                      <div
                        class="flex max-w-sm items-center gap-3 rounded-md border border-border/80 bg-background/60 p-2"
                      >
                        <span
                          class="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground"
                        >
                          <svg
                            class="size-4"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            viewBox="0 0 24 24"
                          >
                            <path
                              d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
                            />
                            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                          </svg>
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate font-medium">{fileLabel(part)}</span>
                          {#if fileDetail(part)}
                            <span class="block truncate text-muted-foreground">
                              {fileDetail(part)}
                            </span>
                          {/if}
                        </span>
                      </div>
                    {/if}
                  {:else if part.type === "dynamic-tool"}
                    <ToolBlock
                      {part}
                      canRespond={!isBusy}
                      onInputResponses={handleInputResponses}
                    />
                  {/if}
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="pb-6 pt-4">
      <form
        class="flex items-end gap-2 rounded-xl border border-border/80 bg-card/50 p-2 shadow-sm transition-colors focus-within:border-border"
        onsubmit={(e) => {
          e.preventDefault();
          submitMessage();
        }}
      >
        <textarea
          bind:value={messageText}
          disabled={isBusy}
          placeholder="Send a message..."
          rows="1"
          class="min-h-20 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onkeydown={onKeydown}
        ></textarea>
        {#if isBusy}
          <button
            type="button"
            aria-label="Stop response"
            class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            onclick={() => agent.stop()}
          >
            <svg class="size-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        {:else}
          <button
            type="submit"
            aria-label="Send message"
            disabled={!messageText.trim()}
            class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            <svg
              class="size-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              <path d="m9 10-5 5 5 5" />
            </svg>
          </button>
        {/if}
      </form>
    </div>
  </section>
</main>
