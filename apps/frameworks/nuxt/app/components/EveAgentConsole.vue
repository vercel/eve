<script setup lang="ts">
import type { EveDynamicToolPart, EveMessagePart } from "eve/vue";

const { data, status, error, send, stop } = useEveAgent();

const isBusy = computed(() => status.value === "submitted" || status.value === "streaming");
const isEmpty = computed(() => data.value.messages.length === 0);

const messagesEl = useTemplateRef("messagesEl");

const isNearBottom = ref(true);
const SCROLL_THRESHOLD = 64;

function onMessagesScroll() {
  const el = messagesEl.value;
  if (!el) return;
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
}

watch(
  () => data.value.messages,
  () => {
    if (!isNearBottom.value) return;
    messagesEl.value?.scrollTo({
      top: messagesEl.value.scrollHeight,
      behavior: "smooth",
    });
  },
  { deep: true, flush: "post" },
);

const messageText = ref("");

function submitMessage() {
  const text = messageText.value.trim();
  if (!text || isBusy.value) return;
  messageText.value = "";
  void send({ message: text });
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
  void send({ inputResponses: responses });
}

function partKey(part: EveMessagePart, index: number): string {
  if (part.type === "dynamic-tool") return part.toolCallId;
  return `${part.type}:${index}`;
}
</script>

<template>
  <main class="flex min-h-dvh flex-col bg-background text-foreground">
    <header class="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur">
      <div class="mx-auto flex h-12 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
        <div class="flex items-center gap-2 font-mono text-[13px] tracking-tight">
          <span class="font-medium">eve</span>
          <span class="text-muted-foreground">/</span>
          <span class="text-muted-foreground">agent</span>
        </div>
        <StatusDot :status="status" />
      </div>
    </header>

    <section class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
      <div
        v-if="error"
        class="mt-4 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
      >
        <div>
          <p class="font-medium">Request failed</p>
          <p class="mt-0.5 text-muted-foreground">
            {{ error.message }}
          </p>
        </div>
      </div>

      <div
        v-if="isEmpty"
        class="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center"
      >
        <h1 class="text-xl font-medium tracking-tight">eve Agent</h1>
        <p class="max-w-sm text-sm text-muted-foreground">
          Ask for the weather in Vienna, or tell the agent to explain the tools it called.
        </p>
      </div>

      <div
        v-else
        ref="messagesEl"
        class="-mx-4 flex-1 overflow-y-auto sm:-mx-6"
        @scroll="onMessagesScroll"
      >
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
          <div
            v-for="message in data.messages"
            :key="message.id"
            class="flex w-full gap-2"
            :class="message.role === 'user' ? 'ml-auto justify-end' : 'justify-start'"
            :data-optimistic="message.metadata?.optimistic ? 'true' : undefined"
          >
            <div
              class="flex w-fit flex-col gap-2 text-sm"
              :class="[
                message.role === 'user'
                  ? 'ml-auto rounded-lg bg-secondary px-4 py-3 text-foreground'
                  : 'w-full text-foreground',
                message.metadata?.optimistic ? 'opacity-70' : '',
              ]"
            >
              <template v-for="(part, index) in message.parts" :key="partKey(part, index)">
                <template v-if="part.type === 'text'">
                  <div class="whitespace-pre-wrap">{{ part.text }}</div>
                </template>

                <ReasoningBlock
                  v-else-if="part.type === 'reasoning'"
                  :text="part.text"
                  :is-streaming="part.state === 'streaming'"
                />

                <ToolBlock
                  v-else-if="part.type === 'dynamic-tool'"
                  :part="part as EveDynamicToolPart"
                  :can-respond="!isBusy"
                  @input-responses="handleInputResponses"
                />
              </template>
            </div>
          </div>
        </div>
      </div>

      <div class="pb-6 pt-4">
        <form
          class="flex items-end gap-2 rounded-xl border border-border/80 bg-card/50 p-2 shadow-sm transition-colors focus-within:border-border"
          @submit.prevent="submitMessage"
        >
          <textarea
            v-model="messageText"
            :disabled="isBusy"
            placeholder="Send a message…"
            rows="1"
            class="min-h-20 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            @keydown="onKeydown"
          />
          <button
            v-if="isBusy"
            type="button"
            class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            @click="stop()"
          >
            <svg class="size-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
          <button
            v-else
            type="submit"
            :disabled="!messageText.trim()"
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
        </form>
      </div>
    </section>
  </main>
</template>
