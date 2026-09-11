<script setup lang="ts">
import { authClient } from "~/lib/auth-client";

definePageMeta({
  layout: false,
  prerender: true,
});

const site = useSite();

const route = useRoute();
const mode = ref<"sign-in" | "sign-up">("sign-in");
const email = ref("");
const password = ref("");
const name = ref("");
const error = ref("");
const loading = ref(false);

const highlights = [
  { icon: "i-lucide-message-square", label: "Web chat" },
  { icon: "i-lucide-smartphone", label: "iMessage" },
  { icon: "i-simple-icons-slack", label: "Slack" },
  { icon: "i-simple-icons-linear", label: "Linear" },
  { icon: "i-lucide-brain", label: "Long-term memory" },
];

const redirectTo = computed(() => {
  const value = route.query.redirect;
  return typeof value === "string" && value.startsWith("/") ? value : "/";
});

async function handleSubmit() {
  error.value = "";
  loading.value = true;

  try {
    if (mode.value === "sign-up") {
      const result = await authClient.signUp.email({
        email: email.value,
        password: password.value,
        name: name.value || email.value.split("@")[0] || "User",
      });

      if (result.error) {
        error.value = result.error.message ?? "Sign up failed.";
        return;
      }
    } else {
      const result = await authClient.signIn.email({
        email: email.value,
        password: password.value,
      });

      if (result.error) {
        error.value = result.error.message ?? "Sign in failed.";
        return;
      }
    }

    await navigateTo(redirectTo.value);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-svh flex-col bg-default text-default lg:flex-row">
    <section
      class="flex flex-1 items-center justify-center border-b border-default px-6 py-10 lg:border-b-0 lg:border-e lg:px-12 lg:py-8"
    >
      <div class="w-full max-w-sm">
        <UCard class="w-full">
          <template #header>
            <h2 class="text-lg font-semibold text-highlighted">
              {{ mode === "sign-in" ? "Sign in" : "Create account" }}
            </h2>
          </template>

          <form class="space-y-4" @submit.prevent="handleSubmit">
            <UFormField v-if="mode === 'sign-up'" label="Name">
              <UInput v-model="name" class="w-full" autocomplete="name" placeholder="Your name" />
            </UFormField>

            <UFormField label="Email">
              <UInput
                v-model="email"
                class="w-full"
                type="email"
                autocomplete="email"
                required
                placeholder="you@example.com"
              />
            </UFormField>

            <UFormField label="Password">
              <UInput
                v-model="password"
                class="w-full"
                type="password"
                autocomplete="current-password"
                required
                minlength="8"
                placeholder="••••••••"
              />
            </UFormField>

            <p v-if="error" class="text-sm text-error">
              {{ error }}
            </p>

            <UButton type="submit" block color="neutral" :loading="loading">
              {{ mode === "sign-in" ? "Sign in" : "Create account" }}
            </UButton>
          </form>

          <template #footer>
            <p class="text-center text-sm text-muted">
              <button
                type="button"
                class="text-highlighted hover:underline"
                @click="mode = mode === 'sign-in' ? 'sign-up' : 'sign-in'"
              >
                {{
                  mode === "sign-in"
                    ? "Need an account? Sign up"
                    : "Already have an account? Sign in"
                }}
              </button>
            </p>
          </template>
        </UCard>
      </div>
    </section>

    <section class="relative flex flex-1 flex-col px-6 py-6 sm:px-8 lg:px-12 lg:py-8 hero-glow">
      <header class="flex items-center justify-between">
        <NuxtLink
          to="https://vercel.com/eve"
          target="_blank"
          class="text-highlighted transition-opacity hover:opacity-80"
          aria-label="Eve on Vercel"
        >
          <Logo class="h-[18px] w-auto text-highlighted" />
        </NuxtLink>

        <UColorModeButton color="neutral" variant="ghost" />
      </header>

      <div class="flex flex-1 flex-col justify-center py-10 lg:py-16">
        <div class="max-w-md space-y-5">
          <div class="space-y-3">
            <h1 class="text-3xl font-semibold tracking-tight text-highlighted sm:text-4xl">V</h1>
            <p class="text-sm leading-relaxed text-muted sm:text-base">
              A durable AI assistant with long-term memory. Chat on the web, Slack, or iMessage —
              query Linear and pick up where you left off.
            </p>
          </div>

          <ul class="flex flex-wrap gap-x-5 gap-y-2">
            <li
              v-for="item in highlights"
              :key="item.label"
              class="flex items-center gap-1.5 text-xs text-toned"
            >
              <UIcon :name="item.icon" class="size-3.5 shrink-0" />
              {{ item.label }}
            </li>
          </ul>
        </div>
      </div>

      <footer class="flex flex-wrap items-center gap-x-4 gap-y-3 pt-6">
        <NuxtLink :to="site.deployUrl" target="_blank" rel="noopener">
          <img src="https://vercel.com/button" alt="Deploy with Vercel" width="133" height="32" />
        </NuxtLink>

        <p class="text-xs text-dimmed">
          Built with
          <NuxtLink
            to="https://vercel.com/eve"
            target="_blank"
            class="text-muted underline-offset-2 hover:text-highlighted hover:underline"
          >
            Eve
          </NuxtLink>
          on Vercel
        </p>
      </footer>
    </section>
  </div>
</template>
