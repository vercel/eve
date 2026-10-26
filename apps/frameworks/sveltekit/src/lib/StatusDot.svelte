<script lang="ts">
  import type { UseEveAgentStatus } from "eve/svelte";

  let { status, error = false }: { status?: UseEveAgentStatus; error?: boolean } = $props();

  let isLive = $derived(status === "busy");
  let tone = $derived.by(() => {
    if (error) return "bg-destructive";
    if (isLive) return "bg-sky-500";
    if (status === "idle") return "bg-emerald-500";
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
  <span>{error ? "error" : status}</span>
</div>
