<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import {
  DEFAULT_SETTINGS,
  GITLAB_COM_ORIGIN,
  addOrigin,
  instanceOrigins,
  originToMatchPattern,
  removeOrigin,
  settings,
  toOrigin,
  type Settings,
} from '@/lib/storage';
import { SEVERITIES, SEVERITY_LABELS } from '@/lib/types';

const origins = ref<string[]>([]);
const input = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
const current = ref<Settings>({ ...DEFAULT_SETTINGS });
const loaded = ref(false);

onMounted(async () => {
  origins.value = await instanceOrigins.getValue();
  current.value = await settings.getValue();
  loaded.value = true;
});

// Persist as the user changes controls; the content script watches this key and
// re-filters an already-rendered widget in place.
watch(
  current,
  (value) => {
    if (loaded.value) void settings.setValue({ ...value });
  },
  { deep: true },
);

async function add(): Promise<void> {
  error.value = null;
  const origin = toOrigin(input.value);

  if (!origin) {
    error.value = 'Enter a URL such as https://gitlab.example.com';
    return;
  }
  if (origin === GITLAB_COM_ORIGIN) {
    error.value = 'gitlab.com is always enabled.';
    return;
  }
  if (origins.value.includes(origin)) {
    error.value = `${origin} is already added.`;
    return;
  }

  busy.value = true;
  try {
    const granted = await browser.permissions.request({
      origins: [originToMatchPattern(origin)],
    });
    if (!granted) {
      error.value = 'Permission was not granted, so this instance was not added.';
      return;
    }
    origins.value = await addOrigin(origin);
    input.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function remove(origin: string): Promise<void> {
  error.value = null;
  origins.value = await removeOrigin(origin);
  // Best effort: Chrome refuses to revoke a permission that another granted
  // pattern still covers, which is not a failure worth reporting.
  await browser.permissions
    .remove({ origins: [originToMatchPattern(origin)] })
    .catch(() => undefined);
}
</script>

<template>
  <main class="page">
    <h1>GitLab SAST widget</h1>
    <p class="ui-muted">
      Shows a summary of the security reports attached to a merge request's pipeline, on GitLab
      Free/CE where the built-in security widget is not available.
    </p>

    <section>
      <h2>GitLab instances</h2>
      <p class="ui-muted">
        The extension reads merge request pages only on the instances listed here. Reports are
        fetched with your existing GitLab session and never leave the browser.
      </p>

      <ul class="list">
        <li class="list-item">
          <span class="ui-mono">{{ GITLAB_COM_ORIGIN }}</span>
          <span class="ui-muted">always enabled</span>
        </li>
        <li v-for="origin in origins" :key="origin" class="list-item">
          <span class="ui-mono">{{ origin }}</span>
          <button type="button" class="ui-button" @click="remove(origin)">Remove</button>
        </li>
      </ul>

      <form class="add-row" @submit.prevent="add">
        <input
          v-model="input"
          class="ui-input"
          type="text"
          placeholder="https://gitlab.example.com"
          spellcheck="false"
          autocomplete="off"
        />
        <button type="submit" class="ui-button ui-button-primary" :disabled="busy">
          {{ busy ? 'Requesting…' : 'Add' }}
        </button>
      </form>

      <p v-if="error" class="ui-danger">{{ error }}</p>
    </section>

    <section>
      <h2>Display</h2>

      <label class="ui-field">
        <input v-model="current.startCollapsed" type="checkbox" />
        <span>Start the widget collapsed</span>
      </label>

      <label class="ui-field">
        <input v-model="current.hideLikelyFalsePositives" type="checkbox" />
        <span>Hide findings the scanner flagged as likely false positives</span>
      </label>

      <label class="ui-field">
        <input v-model="current.verboseLogging" type="checkbox" />
        <span>Log each step to the page console (for troubleshooting)</span>
      </label>

      <label class="ui-field field-block">
        <span>Lowest severity to show</span>
        <select v-model="current.minSeverity" class="ui-select">
          <option v-for="severity in SEVERITIES" :key="severity" :value="severity">
            {{ SEVERITY_LABELS[severity] }}
          </option>
        </select>
      </label>
    </section>
  </main>
</template>

<style scoped>
.page {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px 20px 48px;
}

section {
  margin-top: 28px;
}

.list {
  margin: 12px 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
}

.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
}

.list-item + .list-item {
  border-top: 1px solid var(--ui-border);
}

.add-row {
  display: flex;
  gap: 8px;
}

.field-block {
  display: block;
}

.field-block .ui-select {
  margin-top: 4px;
  max-width: 220px;
}
</style>
