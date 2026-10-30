<script setup lang="ts">
import type { AuthorizationChallengeState } from "~/composables/chat/useAuthorizationChallenges";

const props = defineProps<{
  challenge: AuthorizationChallengeState;
}>();

const label = computed(() => {
  const name = props.challenge.name;
  return name.charAt(0).toUpperCase() + name.slice(1);
});

const icon = computed(() => connectionIcon(props.challenge.name));

const isFailed = computed(
  () => !!props.challenge.outcome && props.challenge.outcome !== "authorized",
);

const statusLabel = computed(() => {
  if (!props.challenge.outcome) {
    return "Authorization required";
  }

  switch (props.challenge.outcome) {
    case "declined":
      return "Declined";
    case "timed-out":
      return "Timed out";
    default:
      return "Failed";
  }
});

const statusDotClass = computed(() => {
  if (isFailed.value) {
    return "bg-red-400/90";
  }
  return "bg-amber-400/90 shadow-[0_0_6px_1px_rgba(251,191,36,0.25)]";
});

const subtitle = computed(() => {
  if (isFailed.value && props.challenge.reason) {
    return props.challenge.reason;
  }
  return (
    props.challenge.description ||
    props.challenge.instructions ||
    `Authorize ${label.value} in your browser to continue.`
  );
});

function openAuthorization() {
  if (!props.challenge.url) {
    return;
  }

  window.open(props.challenge.url, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <div
    class="rounded-lg border border-default/70 bg-elevated/30 transition-[border-color,background-color] duration-150 hover:border-default hover:bg-elevated/50"
  >
    <div
      class="flex flex-col gap-2.5 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:px-3.5 sm:py-3"
    >
      <div class="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-md border border-default/60 bg-default/50"
        >
          <UIcon :name="icon" class="size-4 text-toned" />
        </div>

        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p class="text-sm font-medium text-highlighted">Connect {{ label }}</p>
            <span class="inline-flex items-center gap-1.5 text-[11px] text-dimmed">
              <span class="size-1.5 shrink-0 rounded-full" :class="statusDotClass" />
              {{ statusLabel }}
            </span>
          </div>

          <p class="text-xs text-muted">
            {{ subtitle }}
          </p>

          <div v-if="challenge.userCode && !isFailed" class="flex items-center gap-2">
            <span class="text-[11px] text-dimmed">Code</span>
            <code
              class="rounded border border-default/70 bg-default/60 px-2 py-0.5 font-mono text-xs tracking-wider text-toned"
            >
              {{ challenge.userCode }}
            </code>
          </div>
        </div>
      </div>

      <UButton
        v-if="challenge.url"
        color="neutral"
        variant="soft"
        size="xs"
        class="shrink-0 self-end sm:self-center"
        trailing-icon="i-lucide-arrow-up-right"
        @click="openAuthorization"
      >
        {{ isFailed ? `Retry ${label}` : `Connect ${label}` }}
      </UButton>
    </div>
  </div>
</template>
