<script setup lang="ts">
import type { ConnectorSummary } from "#shared/types/connector";

const props = defineProps<{
  connector: ConnectorSummary;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const {
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
} = useConnector(
  () => props.connector,
  () => emit("refresh"),
);

const statusDotClass = computed(() => {
  switch (status.value.color) {
    case "success":
      return "bg-emerald-400/90";
    case "warning":
      return "bg-amber-400/90";
    case "error":
      return "bg-red-400/90";
    default:
      return "bg-toned";
  }
});
</script>

<template>
  <div>
    <div class="flex items-center gap-3 px-4 py-3">
      <div
        class="flex size-8 shrink-0 items-center justify-center rounded-md border border-default bg-elevated"
      >
        <UIcon :name="connector.icon" class="size-4 text-toned" />
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h2 class="text-sm text-highlighted">
            {{ connector.name }}
          </h2>
          <span class="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <span class="size-1.5 shrink-0 rounded-full" :class="statusDotClass" />
            {{ status.label }}
          </span>
        </div>
        <p class="truncate text-xs text-muted">
          <span v-if="connector.connectedAs" class="text-toned">{{ connector.connectedAs }}</span>
          <span v-if="connector.connectedAs" class="text-dimmed"> · </span>
          {{ connector.description }}
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <UButton
          v-if="canConnect"
          color="neutral"
          variant="soft"
          size="xs"
          :loading="connecting"
          trailing-icon="i-lucide-arrow-up-right"
          @click="connect"
        >
          Connect
        </UButton>

        <template v-if="isConnected">
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-play"
            :loading="testing"
            aria-label="Test connection"
            @click="test"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-unplug"
            aria-label="Disconnect"
            @click="
              () => {
                showRevokeModal = true;
              }
            "
          />
        </template>
      </div>
    </div>

    <div v-if="needsSetup" class="border-t border-default px-4 py-3">
      <p class="text-xs text-toned">
        {{ setupStatus?.message }}
      </p>
      <div v-if="hintLines.length" class="mt-2 space-y-1">
        <code
          v-for="(line, index) in hintLines.filter(isCliHintLine)"
          :key="index"
          class="block rounded-md border border-default bg-elevated px-2 py-1 font-mono text-[11px] text-toned"
          >{{ line }}</code
        >
      </div>
    </div>

    <p v-else-if="errorStatus" class="border-t border-default px-4 py-2 text-xs text-error">
      {{ errorStatus.message }}
    </p>

    <p v-if="actionError" class="border-t border-default px-4 py-2 text-xs text-error">
      {{ actionError }}
    </p>

    <div v-if="showTestResults && testResults?.length" class="border-t border-default px-4 py-3">
      <div class="overflow-hidden rounded-md border border-default">
        <div class="flex items-center justify-between border-b border-default px-2.5 py-1.5">
          <p class="text-[10px] font-medium tracking-wide text-dimmed uppercase">
            {{ parsedResults.length }} {{ resultsHeading.toLowerCase() }}
          </p>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-x"
            aria-label="Clear results"
            @click="clearResults"
          />
        </div>
        <ul class="max-h-36 divide-y divide-default overflow-y-auto">
          <li
            v-for="(result, index) in parsedResults.slice(0, 5)"
            :key="index"
            class="px-2.5 py-1.5 text-xs"
          >
            <span v-if="result.id" class="font-mono text-toned">{{ result.id }}</span>
            <span v-if="result.id" class="text-dimmed"> · </span>
            <span class="text-muted">{{ result.title }}</span>
          </li>
        </ul>
      </div>
    </div>

    <UModal
      v-model:open="showRevokeModal"
      :title="`Disconnect ${connector.name}?`"
      description="V will lose access until you connect again."
    >
      <template #footer>
        <UButton
          color="neutral"
          variant="ghost"
          @click="
            () => {
              showRevokeModal = false;
            }
          "
        >
          Cancel
        </UButton>
        <UButton color="error" size="sm" :loading="revoking" @click="revoke"> Disconnect </UButton>
      </template>
    </UModal>
  </div>
</template>
