<script lang="ts">
  import type { UseEveAgentStatus } from "eve/svelte";

  let { status }: { status?: UseEveAgentStatus } = $props();

  let isLive = $derived(status === "submitted" || status === "streaming");
  let tone = $derived.by(() => {
    if (status === "error") return "bg-destructive";
    if (isLive) return "bg-sky-500";
    if (status === "ready") return "bg-emerald-500";
    return "bg-muted-foreground/50";
  });
</script>

<div class="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
  <span class="relative flex size-1.5">
    {#if isLive}
      <span class="{tone} absolute inline-flex size-full animate-ping rounded-full opacity-75"></span>
    {/if}
    <span class="{tone} relative inline-flex size-1.5 rounded-full"></span>
  </span>
  <span>{status}</span>
</div>
