import { getErrorStatus, getSetupStatus } from "#shared/utils/status";
import type { ConnectorSummary } from "#shared/types/connector";
import { getPendingChallenge } from "~/composables/chat/useAuthorizationChallenges";

/**
 * Connect / test / revoke actions and derived UI state for one connector row.
 */
export function useConnector(connector: () => ConnectorSummary, onRefresh?: () => void) {
  const connecting = ref(false);
  const testing = ref(false);
  const revoking = ref(false);
  const showRevokeModal = ref(false);
  const showTestResults = ref(false);
  const testResults = ref<string[] | null>(null);
  const actionError = ref<string | null>(null);

  const id = computed(() => connector().id);
  const status = computed(() => connectorStatusLabel(connector().status.state));

  const canConnect = computed(() => {
    const state = connector().status.state;
    return state === "not_connected" || state === "installation_required";
  });

  const isConnected = computed(() => connector().status.state === "connected");
  const needsSetup = computed(() => connector().status.state === "setup_required");
  const setupStatus = computed(() => getSetupStatus(connector().status));
  const errorStatus = computed(() => getErrorStatus(connector().status));
  const hintLines = computed(() => setupStatus.value?.hint?.split("\n").filter(Boolean) ?? []);

  const parsedResults = computed(() =>
    (testResults.value ?? []).map((line) => parseTestResult(line)),
  );

  const resultsHeading = computed(() => testResultsHeading(connector().id));

  async function connect() {
    connecting.value = true;
    actionError.value = null;
    try {
      const pending = getPendingChallenge(connector().connectionName);
      const resumeUrl = pending?.webhookUrl;
      const query = resumeUrl ? `?resumeUrl=${encodeURIComponent(resumeUrl)}` : "";

      const { url } = await $fetch<{ url: string }>(
        `/api/integrations/${id.value}/connect${query}`,
        {
          method: "POST",
        },
      );
      await navigateTo(url, { external: true });
    } catch (error) {
      actionError.value = getFetchErrorMessage(error);
    } finally {
      connecting.value = false;
    }
  }

  async function test() {
    testing.value = true;
    actionError.value = null;
    testResults.value = null;
    showTestResults.value = false;
    try {
      const { results } = await $fetch<{ results: string[] }>(
        `/api/integrations/${id.value}/test`,
        {
          method: "POST",
        },
      );
      testResults.value = results;
      showTestResults.value = true;
      onRefresh?.();
    } catch (error) {
      actionError.value = getFetchErrorMessage(error);
    } finally {
      testing.value = false;
    }
  }

  async function revoke() {
    revoking.value = true;
    actionError.value = null;
    try {
      await $fetch(`/api/integrations/${id.value}/revoke`, {
        method: "POST",
      });
      testResults.value = null;
      showTestResults.value = false;
      showRevokeModal.value = false;
      onRefresh?.();
    } catch (error) {
      actionError.value = getFetchErrorMessage(error);
    } finally {
      revoking.value = false;
    }
  }

  function clearResults() {
    testResults.value = null;
    showTestResults.value = false;
  }

  return {
    status,
    canConnect,
    isConnected,
    needsSetup,
    setupStatus,
    errorStatus,
    hintLines,
    connecting,
    testing,
    revoking,
    showRevokeModal,
    showTestResults,
    testResults,
    actionError,
    parsedResults,
    resultsHeading,
    connect,
    test,
    revoke,
    clearResults,
  };
}
