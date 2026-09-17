<script setup lang="ts">
import { authClient } from "~/lib/auth-client";

const { profile, pending, saveProfile, timezones, locales } = useProfile();
const { memory, pending: memoryPending } = useMemory();

const form = reactive({
  name: "",
  phoneNumber: "",
  timezone: "UTC",
  locale: "en",
  bio: "",
});

const saving = ref(false);
const toast = useToast();

const isDirty = computed(() => {
  if (!profile.value) return false;
  return (
    form.name !== profile.value.name ||
    form.phoneNumber !== (profile.value.phoneNumber ?? "") ||
    form.timezone !== profile.value.timezone ||
    form.locale !== profile.value.locale ||
    form.bio !== profile.value.bio
  );
});

watch(
  profile,
  (value) => {
    if (!value) return;
    form.name = value.name;
    form.phoneNumber = value.phoneNumber ?? "";
    form.timezone = value.timezone;
    form.locale = value.locale;
    form.bio = value.bio;
  },
  { immediate: true },
);

async function handleSave() {
  if (saving.value || !isDirty.value) return;

  saving.value = true;
  try {
    await saveProfile({
      name: form.name.trim(),
      phoneNumber: form.phoneNumber.trim() || null,
      timezone: form.timezone,
      locale: form.locale,
      bio: form.bio,
    });
    await authClient.getSession({ query: { disableCookieCache: true } });
    toast.add({ title: "Profile saved", color: "success" });
  } catch {
    toast.add({ title: "Could not save profile", color: "error" });
  } finally {
    saving.value = false;
  }
}

function resetForm() {
  if (!profile.value) return;
  form.name = profile.value.name;
  form.phoneNumber = profile.value.phoneNumber ?? "";
  form.timezone = profile.value.timezone;
  form.locale = profile.value.locale;
  form.bio = profile.value.bio;
}
</script>

<template>
  <UDashboardPanel id="profile" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-2xl px-6 py-8">
        <header class="mb-8">
          <h1 class="mb-1 text-lg font-medium text-highlighted">Settings</h1>
          <p class="max-w-lg text-sm text-muted">Manage your identity, memory, and integrations.</p>
        </header>

        <SettingsNav class="mb-8" />

        <div v-if="pending" class="space-y-8">
          <USkeleton class="h-48 rounded-lg" />
          <USkeleton class="h-32 rounded-lg" />
        </div>

        <form v-else id="profile-form" class="space-y-8" @submit.prevent="handleSave">
          <SettingsSection
            title="Profile"
            description="How V identifies you across web, Slack, and iMessage."
          >
            <SettingsRow
              label="Name"
              description="Shown in the sidebar and used when V addresses you."
            >
              <UInput v-model="form.name" class="w-full max-w-md" placeholder="Your name" />
            </SettingsRow>

            <SettingsRow
              label="Email"
              description="Used for sign-in. Contact support to change it."
            >
              <p class="text-sm text-toned">
                {{ profile?.email }}
              </p>
            </SettingsRow>

            <SettingsRow
              label="Phone"
              description="Your E.164 number for iMessage linking via Sendblue."
            >
              <ProfilePhoneInput
                v-model="form.phoneNumber"
                :default-country="form.locale === 'fr' ? 'FR' : 'US'"
              />
            </SettingsRow>

            <SettingsRow label="Bio" description="A short intro injected into every conversation.">
              <UTextarea
                v-model="form.bio"
                :rows="3"
                class="w-full"
                placeholder="Staff engineer at Acme. Building observability tools. Based in Paris."
                autoresize
                :maxrows="8"
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Preferences" description="Locale and regional settings.">
            <SettingsRow
              inline
              label="Timezone"
              description="Used for schedules and time-aware replies."
            >
              <UInputMenu
                v-model="form.timezone"
                :items="timezones"
                value-key="value"
                label-key="label"
                description-key="description"
                :filter-fields="['label', 'value', 'description']"
                placeholder="Search timezone…"
                icon="i-lucide-globe"
                class="w-48"
                :ui="{ content: 'min-w-(--reka-combobox-trigger-width)' }"
              />
            </SettingsRow>

            <SettingsRow inline label="Language">
              <UInputMenu
                v-model="form.locale"
                :items="locales"
                value-key="value"
                label-key="label"
                description-key="description"
                :filter-fields="['label', 'value', 'description']"
                placeholder="Search language…"
                icon="i-lucide-languages"
                class="w-40"
              />
            </SettingsRow>
          </SettingsSection>
        </form>

        <ProfileMemorySection class="mt-8" :memory="memory" :pending="memoryPending" />
      </div>
    </template>

    <template #footer>
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-full opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="translate-y-0 opacity-100"
        leave-to-class="translate-y-full opacity-0"
      >
        <div
          v-if="isDirty && !pending"
          class="border-t border-default bg-elevated/95 backdrop-blur supports-[backdrop-filter]:bg-elevated/90"
        >
          <div class="mx-auto w-full max-w-2xl px-6">
            <div class="flex items-center justify-between gap-4 py-3">
              <p class="text-sm text-muted">You have unsaved changes</p>
              <div class="flex gap-2">
                <UButton
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="saving"
                  @click="resetForm"
                >
                  Discard
                </UButton>
                <UButton
                  color="primary"
                  size="sm"
                  form="profile-form"
                  type="submit"
                  :loading="saving"
                >
                  Save changes
                </UButton>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </template>
  </UDashboardPanel>
</template>
