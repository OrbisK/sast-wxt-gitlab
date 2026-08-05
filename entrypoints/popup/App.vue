<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { RegistrationStatus, Request } from '@/lib/messages';
import { parseMrPath } from '@/lib/gitlab-page';
import {
  GITLAB_COM_ORIGIN,
  addOrigin,
  instanceOrigins,
  originToMatchPattern,
} from '@/lib/storage';

type Status = 'checking' | 'not-a-page' | 'active' | 'available' | 'granting' | 'granted';

const status = ref<Status>('checking');
const origin = ref<string | null>(null);
const pathname = ref<string>('');
const error = ref<string | null>(null);
const registration = ref<RegistrationStatus | null>(null);

const isMergeRequest = computed(() => Boolean(parseMrPath(pathname.value)));

/** Configured and permitted, but the background never registered a script for it. */
const registrationBroken = computed(() => {
  const value = registration.value;
  if (!value || !origin.value || origin.value === GITLAB_COM_ORIGIN) return false;
  if (!value.configured.includes(origin.value)) return false;
  return !value.registered.includes(originToMatchPattern(origin.value));
});

onMounted(async () => {
  // `activeTab` gives us the URL of the tab the popup was opened from, without
  // needing a broad "tabs" permission.
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;

  if (!url || !/^https?:/i.test(url)) {
    status.value = 'not-a-page';
    return;
  }

  const parsed = new URL(url);
  origin.value = parsed.origin;
  pathname.value = parsed.pathname;
  registration.value = await ask({ type: 'get-registration-status' });
  status.value = (await isEnabled(parsed.origin)) ? 'active' : 'available';
});

async function ask(message: Request): Promise<RegistrationStatus | null> {
  try {
    return (await browser.runtime.sendMessage(message)) as RegistrationStatus;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    return null;
  }
}

async function isEnabled(value: string): Promise<boolean> {
  if (value === GITLAB_COM_ORIGIN) return true;
  const configured = await instanceOrigins.getValue();
  if (!configured.includes(value)) return false;
  return browser.permissions.contains({ origins: [originToMatchPattern(value)] });
}

async function enableHere(): Promise<void> {
  if (!origin.value) return;
  error.value = null;
  status.value = 'granting';

  try {
    const granted = await browser.permissions.request({
      origins: [originToMatchPattern(origin.value)],
    });
    if (!granted) {
      status.value = 'available';
      error.value = 'Permission was not granted.';
      return;
    }
    await addOrigin(origin.value);
    // Register immediately rather than relying on the permission/storage events
    // reaching a sleeping service worker.
    registration.value = await ask({ type: 'sync-registration' });
    status.value = 'granted';
  } catch (cause) {
    status.value = 'available';
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function repair(): Promise<void> {
  error.value = null;
  registration.value = await ask({ type: 'sync-registration' });
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
  window.close();
}

async function reloadTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await browser.tabs.reload(tab.id);
  window.close();
}
</script>

<template>
  <div class="popup">
    <h1>Merge Request Security Widget for GitLab</h1>

    <p v-if="status === 'checking'" class="ui-muted">Checking this tab…</p>

    <p v-else-if="status === 'not-a-page'" class="ui-muted">
      Open a GitLab merge request to use this extension.
    </p>

    <template v-else>
      <p class="ui-mono ui-muted">{{ origin }}</p>

      <template v-if="status === 'active'">
        <p v-if="registrationBroken" class="ui-danger">
          Enabled, but no content script is registered for this instance. Try repairing, then reload
          the tab.
        </p>
        <p v-else>Active on this instance.</p>

        <p v-if="!isMergeRequest" class="ui-muted">
          This page is not a merge request, so nothing will be injected here.
        </p>

        <div class="ui-row">
          <button type="button" class="ui-button" @click="repair">Repair registration</button>
          <button type="button" class="ui-button" @click="reloadTab">Reload tab</button>
        </div>
      </template>

      <template v-else-if="status === 'granted'">
        <p>Enabled. Reload the tab for the widget to appear.</p>
        <button type="button" class="ui-button ui-button-primary" @click="reloadTab">
          Reload tab
        </button>
      </template>

      <template v-else>
        <p class="ui-muted">
          This instance is not enabled yet. The extension only reads pages on instances you allow.
        </p>
        <button
          type="button"
          class="ui-button ui-button-primary"
          :disabled="status === 'granting'"
          @click="enableHere"
        >
          {{ status === 'granting' ? 'Requesting…' : 'Enable on this instance' }}
        </button>
      </template>

      <p v-if="error" class="ui-danger">{{ error }}</p>

      <details v-if="registration" class="diag">
        <summary class="ui-muted">Diagnostics</summary>
        <dl>
          <dt>Registered</dt>
          <dd class="ui-mono">{{ registration.registered.join(', ') || 'none' }}</dd>
          <dt>Configured</dt>
          <dd class="ui-mono">{{ registration.configured.join(', ') || 'none' }}</dd>
          <dt v-if="registration.missingPermission.length">Missing permission</dt>
          <dd v-if="registration.missingPermission.length" class="ui-mono ui-danger">
            {{ registration.missingPermission.join(', ') }}
          </dd>
          <dt v-if="registration.error">Last error</dt>
          <dd v-if="registration.error" class="ui-danger">{{ registration.error }}</dd>
        </dl>
      </details>
    </template>

    <hr />

    <button type="button" class="ui-button" @click="openOptions">Settings</button>
  </div>
</template>

<style scoped>
.popup {
  width: 320px;
  padding: 14px;
}

hr {
  margin: 14px 0 10px;
  border: 0;
  border-top: 1px solid var(--ui-border);
}

.diag {
  margin-top: 12px;
  font-size: 12px;
}

.diag dl {
  margin: 8px 0 0;
}

.diag dt {
  margin-top: 6px;
  color: var(--ui-text-subtle);
}

.diag dd {
  margin: 0;
}
</style>
