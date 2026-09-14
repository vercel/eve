import type { SlackLinkSummary } from "#shared/types/slack-link";

export function useSlackLink() {
  const toast = useToast();

  const { data, pending, error, refresh } = useFetch<SlackLinkSummary>("/api/slack/link", {
    server: false,
    ...payloadCacheOptions,
  });

  const isLinked = computed(() => data.value?.linked === true);
  const pendingCode = computed(() => data.value?.pendingCode);
  const generating = ref(false);

  async function generateLinkCode() {
    generating.value = true;
    try {
      await $fetch("/api/slack/link/code", { method: "POST" });
      await refresh();
      toast.add({
        title: "Link code ready",
        description: "Send it to @V in Slack to finish linking.",
        color: "success",
        icon: "i-lucide-link",
      });
    } catch (cause) {
      toast.add({
        title: "Could not generate code",
        description: cause instanceof Error ? cause.message : "Try again.",
        color: "error",
        icon: "i-lucide-alert-circle",
      });
    } finally {
      generating.value = false;
    }
  }

  async function unlinkSlack() {
    await $fetch("/api/slack/link", { method: "DELETE" });
    await refresh();
  }

  return {
    data,
    pending,
    error,
    refresh,
    isLinked,
    pendingCode,
    generating,
    generateLinkCode,
    unlinkSlack,
  };
}
