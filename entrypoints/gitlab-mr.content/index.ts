import { createApp, h, reactive, type App } from 'vue';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createIntegratedUi } from 'wxt/utils/content-script-ui/integrated';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { IntegratedContentScriptUi } from 'wxt/utils/content-script-ui/integrated';
import SastWidget from '@/components/SastWidget.vue';
import { findAnchor, waitForAnchor } from '@/lib/anchor';
import { bail, error as logError, log, setVerbose } from '@/lib/debug';
import { looksLikeGitLab, parseMrPath, type MrPageContext } from '@/lib/gitlab-page';
import { discoverReports, loadReports } from '@/lib/scan';
import { DEFAULT_SETTINGS, settings, type Settings } from '@/lib/storage';
import type { WidgetState } from '@/lib/types';
import './widget.css';

interface Store {
  state: WidgetState;
  settings: Settings;
}

/** One merge request's worth of work, so a soft navigation can cancel it. */
interface Session {
  iid: number;
  abort: AbortController;
  store: Store;
  ui: IntegratedContentScriptUi<App<Element>> | null;
}

export default defineContentScript({
  // gitlab.com is declared here; self-managed instances are registered at
  // runtime by the background script once the user grants access to them.
  matches: ['*://gitlab.com/*'],
  runAt: 'document_idle',

  async main(ctx) {
    const initial = await settings.getValue();
    setVerbose(initial.verboseLogging);

    // Proof of life: if this line is absent from the console, the content script
    // itself never ran and the problem is registration, not detection.
    log('content script active on', location.href);

    let session: Session | null = null;

    const teardown = () => {
      session?.abort.abort();
      session?.ui?.remove();
      session = null;
    };

    const sync = async () => {
      const page = parseMrPath(location.pathname);
      if (!page) {
        bail('not a merge request page', location.pathname);
        teardown();
        return;
      }
      if (!looksLikeGitLab()) {
        bail('page does not look like GitLab (no GitLab meta tags or layout found)');
        teardown();
        return;
      }

      // Switching between the Overview and Changes tabs fires a location change
      // but stays on the same merge request; there is nothing to re-fetch.
      if (session?.iid === page.iid) {
        log('already handling merge request', page.iid);
        return;
      }

      teardown();
      log('handling merge request', page.iid, 'in', page.pathPrefix);

      const active: Session = {
        iid: page.iid,
        abort: new AbortController(),
        store: reactive<Store>({
          state: { status: 'loading', reportTypes: [] },
          settings: await settings.getValue(),
        }) as Store,
        ui: null,
      };
      session = active;

      try {
        await run(ctx, page, active);
      } catch (cause) {
        logError('failed to render the widget', cause);
      }

      // A navigation during the fetch above already tore this session down.
      if (active.abort.signal.aborted) active.ui?.remove();
    };

    await sync();

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      void sync();
    });

    // Keep an already-rendered widget's filters in step with the options page.
    settings.watch((value) => {
      setVerbose((value ?? DEFAULT_SETTINGS).verboseLogging);
      if (session) session.store.settings = value ?? DEFAULT_SETTINGS;
    });

    ctx.onInvalidated(teardown);
  },
});

async function run(
  ctx: ContentScriptContext,
  page: MrPageContext,
  session: Session,
): Promise<void> {
  const { signal } = session.abort;
  const outcome = await discoverReports(page);
  if (signal.aborted || ctx.isInvalid) return;

  // No pipeline, or a merge request page we cannot read: stay invisible.
  if (outcome.status === 'not-applicable') {
    bail(outcome.reason);
    return;
  }

  if (outcome.status === 'error') {
    logError(outcome.message);
    session.store.state = { status: 'error', message: outcome.message };
    session.ui = await mountWidget(ctx, signal, session.store);
    return;
  }

  const { discovery } = outcome;

  // Stay invisible on merge requests that simply have no security scanning.
  if (discovery.sources.length === 0) {
    bail(
      `pipeline ${discovery.info.pipelineId} has no security report artifacts ` +
        '(the jobs and their artifact types are logged above)',
    );
    return;
  }

  session.store.state = {
    status: 'loading',
    reportTypes: discovery.sources.map((source) => source.reportType),
  };
  session.ui = await mountWidget(ctx, signal, session.store);
  if (!session.ui) return;

  try {
    const result = await loadReports(page, discovery);
    if (!signal.aborted) {
      log(`rendered ${result.findings.length} finding(s)`, result.counts);
      session.store.state = { status: 'ok', result };
    }
  } catch (cause) {
    logError('failed to download the reports', cause);
    if (!signal.aborted) {
      session.store.state = {
        status: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
}

async function mountWidget(
  ctx: ContentScriptContext,
  signal: AbortSignal,
  store: Store,
): Promise<IntegratedContentScriptUi<App<Element>> | null> {
  const anchor = findAnchor() ?? (await waitForAnchor(signal));
  if (!anchor) {
    bail('found nothing on the page to attach the widget to');
    return null;
  }
  if (signal.aborted || ctx.isInvalid) return null;

  const ui = createIntegratedUi(ctx, {
    position: 'inline',
    anchor: anchor.element,
    append: anchor.append,
    onMount(container) {
      // A render function rather than a static props object, so the reactive
      // store drives updates as the reports finish downloading.
      const app = createApp(() => h(SastWidget, { state: store.state, settings: store.settings }));
      app.mount(container);
      return app;
    },
    onRemove(app) {
      app?.unmount();
    },
  });

  ui.mount();
  log('widget mounted', anchor.append, anchor.selector);
  return ui;
}
