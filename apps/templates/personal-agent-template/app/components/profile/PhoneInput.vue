<script setup lang="ts">
import { vMaska } from "maska/vue";
import { formatPhoneNumber, parsePhoneNumber, PHONE_CODES } from "#shared/phone-codes";

const props = withDefaults(
  defineProps<{
    defaultCountry?: string;
    size?: "sm" | "md" | "lg" | "xl";
  }>(),
  {
    defaultCountry: "FR",
    size: "lg",
  },
);

const model = defineModel<string>({ default: "" });

const countryCode = ref(props.defaultCountry);
const localNumber = ref("");
const syncing = ref(false);

const country = computed(() => PHONE_CODES.find((entry) => entry.code === countryCode.value));
const dialCode = computed(() => country.value?.dialCode ?? "+33");
const mask = computed(() => country.value?.mask ?? "# ## ## ## ##");
const placeholder = computed(() => mask.value.replaceAll("#", "_"));

function syncFromModel(value: string) {
  syncing.value = true;
  const parsed = parsePhoneNumber(value, props.defaultCountry);
  countryCode.value = parsed.countryCode;
  localNumber.value = parsed.local;
  syncing.value = false;
}

function emitModel() {
  if (syncing.value) {
    return;
  }

  model.value = formatPhoneNumber(countryCode.value, localNumber.value);
}

watch(
  () => model.value,
  (value) => {
    const formatted = formatPhoneNumber(countryCode.value, localNumber.value);
    if (value !== formatted) {
      syncFromModel(value);
    }
  },
  { immediate: true },
);

watch(countryCode, (next, previous) => {
  if (syncing.value || next === previous) {
    return;
  }

  localNumber.value = "";
  emitModel();
});

watch(localNumber, emitModel);
</script>

<template>
  <UFieldGroup class="w-full">
    <USelectMenu
      v-model="countryCode"
      :items="PHONE_CODES"
      value-key="code"
      :search-input="{
        placeholder: 'Search country…',
        icon: 'i-lucide-search',
      }"
      :filter-fields="['name', 'code', 'dialCode']"
      :content="{ align: 'start' }"
      :size="size"
      :ui="{
        base: 'pe-8',
        content: 'min-w-48',
        placeholder: 'hidden',
        trailingIcon: 'size-4',
      }"
      trailing-icon="i-lucide-chevrons-up-down"
    >
      <span class="flex size-5 items-center text-lg">
        {{ country?.emoji ?? "🇫🇷" }}
      </span>

      <template #item-leading="{ item }">
        <span class="flex size-5 items-center text-lg">
          {{ item.emoji }}
        </span>
      </template>

      <template #item-label="{ item }"> {{ item.name }} ({{ item.dialCode }}) </template>
    </USelectMenu>

    <UInput
      :key="countryCode"
      v-model="localNumber"
      v-maska="mask"
      type="tel"
      inputmode="tel"
      autocomplete="tel-national"
      class="min-w-0 flex-1"
      :size="size"
      :placeholder="placeholder"
      :style="{ '--dial-code-length': `${dialCode.length + 1.5}ch` }"
      :ui="{
        base: 'ps-(--dial-code-length) w-full',
        leading: 'pointer-events-none text-base md:text-sm text-muted',
      }"
    >
      <template #leading>
        {{ dialCode }}
      </template>
    </UInput>
  </UFieldGroup>
</template>
