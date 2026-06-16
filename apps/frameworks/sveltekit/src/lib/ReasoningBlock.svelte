<script lang="ts">
  let { text, isStreaming }: { text: string; isStreaming: boolean } = $props();

  let userOpen = $state(true);
  let isOpen = $derived(isStreaming || userOpen);
</script>

<div class="w-full">
  <button
    type="button"
    class="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
    onclick={() => {
      userOpen = !isOpen;
    }}
  >
    <svg class="size-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path
        d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z"
      />
      <path d="M9.5 22h5" />
    </svg>
    {#if isStreaming}
      <span class="italic">Thinking...</span>
    {:else}
      <span>Thought</span>
    {/if}
    <svg
      class="size-4 transition-transform {isOpen ? 'rotate-180' : ''}"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>
  {#if isOpen}
    <div class="mt-2 text-sm text-muted-foreground">
      <div class="whitespace-pre-wrap">{text}</div>
    </div>
  {/if}
</div>
