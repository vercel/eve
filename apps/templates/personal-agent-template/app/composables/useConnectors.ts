import type { ConnectorSummary } from "#shared/types/connector";
import { resolveAuthorizationChallenge } from "~/composables/chat/useAuthorizationChallenges";

/**
 * Loads connector summaries and handles the OAuth return query (`?connected=`).
 */
export function useConnectors() {
  const route = useRoute();
  const router = useRouter();
  const toast = useToast();

  const {
    data: connectors,
    pending,
    error,
    refresh,
  } = useFetch<ConnectorSummary[]>("/api/connectors", {
    server: false,
    ...payloadCacheOptions,
  });

  const isInitialLoad = computed(() => pending.value && !connectors.value);

  async function handleOAuthReturn() {
    const connectedId = route.query.connected;
    if (!connectedId || typeof connectedId !== "string") {
      return;
    }

    await refresh();

    const connected = connectors.value?.find((connector) => connector.id === connectedId);
    const name = connected?.name ?? connectedId.charAt(0).toUpperCase() + connectedId.slice(1);

    if (connected?.connectionName) {
      await resolveAuthorizationChallenge(connected.connectionName);
    }

    toast.add({
      title: `${name} connected`,
      description: "Run a test to verify the integration works.",
      color: "success",
      icon: "i-lucide-check-circle",
    });

    await router.replace({ query: {} });
  }

  onMounted(() => {
    void handleOAuthReturn();

    if (import.meta.client) {
      const onFocus = () => {
        void refresh();
      };
      window.addEventListener("focus", onFocus);
      onUnmounted(() => window.removeEventListener("focus", onFocus));
    }
  });
  watch(() => route.query.connected, handleOAuthReturn);

  return {
    connectors,
    pending,
    error,
    refresh,
    isInitialLoad,
  };
}
