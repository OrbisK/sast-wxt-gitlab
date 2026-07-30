import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { error as logError, log, setVerbose } from '@/lib/debug';
import type { RegistrationStatus, Request } from '@/lib/messages';
import {
  GITLAB_COM_ORIGIN,
  getSettings,
  instanceOrigins,
  originToMatchPattern,
} from '@/lib/storage';

/**
 * Content script bundle paths, as emitted by WXT for the
 * `entrypoints/gitlab-mr.content/` entrypoint. Kept in one place because the
 * runtime registration below has to name them literally.
 */
const CONTENT_SCRIPT_JS = 'content-scripts/gitlab-mr.js';
const CONTENT_SCRIPT_CSS = 'content-scripts/gitlab-mr.css';
const REGISTRATION_ID = 'gitlab-sast-widget-instances';

/** Surfaced to the popup so a failed registration is visible in the UI. */
let lastError: string | undefined;

export default defineBackground(() => {
  void getSettings().then((value) => setVerbose(value.verboseLogging));

  // gitlab.com is covered by the declared content script. Every other origin is
  // opt-in, so its content script is registered here once the user has granted
  // permission for it.
  void syncRegistration();

  browser.runtime.onInstalled.addListener(() => void syncRegistration());
  browser.runtime.onStartup.addListener(() => void syncRegistration());
  browser.permissions.onAdded.addListener(() => void syncRegistration());
  browser.permissions.onRemoved.addListener(() => void syncRegistration());
  instanceOrigins.watch(() => void syncRegistration());

  browser.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
    // The popup drives this so that "granted the permission but no script got
    // registered" is a visible state rather than a silent one.
    const handle = async (): Promise<RegistrationStatus> => {
      if (message?.type === 'sync-registration') await syncRegistration();
      return describeRegistration();
    };

    if (message?.type === 'sync-registration' || message?.type === 'get-registration-status') {
      handle().then(sendResponse, (cause) => {
        logError('status request failed', cause);
        sendResponse({
          registered: [],
          configured: [],
          missingPermission: [],
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
      return true; // keep the message channel open for the async response
    }
    return false;
  });
});

async function describeRegistration(): Promise<RegistrationStatus> {
  const configured = await instanceOrigins.getValue();
  const missingPermission: string[] = [];

  for (const origin of configured) {
    if (!(await browser.permissions.contains({ origins: [originToMatchPattern(origin)] }))) {
      missingPermission.push(origin);
    }
  }

  const existing = await browser.scripting
    .getRegisteredContentScripts({ ids: [REGISTRATION_ID] })
    .catch(() => []);

  return {
    registered: existing.flatMap((script) => script.matches ?? []),
    configured,
    missingPermission,
    error: lastError,
  };
}

/**
 * Registers (or clears) one dynamic content script covering every configured
 * origin we actually hold permission for. Origins whose permission was revoked
 * are dropped rather than registered, which would throw.
 */
async function syncRegistration(): Promise<void> {
  const configured = await instanceOrigins.getValue();
  const patterns: string[] = [];

  for (const origin of configured) {
    if (origin === GITLAB_COM_ORIGIN) continue;
    const pattern = originToMatchPattern(origin);
    if (await browser.permissions.contains({ origins: [pattern] })) {
      patterns.push(pattern);
    } else {
      log('skipping', origin, '- host permission not granted');
    }
  }

  // `unregister` throws when the id is unknown, which is the normal case on a
  // fresh profile.
  await browser.scripting
    .unregisterContentScripts({ ids: [REGISTRATION_ID] })
    .catch(() => undefined);

  if (patterns.length === 0) {
    log('no additional instances to register');
    lastError = undefined;
    return;
  }

  try {
    await browser.scripting.registerContentScripts([
      {
        id: REGISTRATION_ID,
        matches: patterns,
        js: [CONTENT_SCRIPT_JS],
        css: [CONTENT_SCRIPT_CSS],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
    lastError = undefined;
    log('registered content script for', patterns);
  } catch (cause) {
    lastError = cause instanceof Error ? cause.message : String(cause);
    logError('could not register content scripts for', patterns, cause);
  }
}
