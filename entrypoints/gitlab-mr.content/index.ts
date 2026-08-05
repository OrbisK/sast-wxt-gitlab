import { createApp, h, reactive, type App } from 'vue';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createIntegratedUi } from 'wxt/utils/content-script-ui/integrated';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { IntegratedContentScriptUi } from 'wxt/utils/content-script-ui/integrated';
import SecurityWidget from '@/components/SecurityWidget.vue';
import { fitHost, waitForAnchor } from '@/lib/anchor';
import { bail, error as logError, log, setVerbose } from '@/lib/debug';
import type { MrInfo } from '@/lib/gitlab-api';
import { looksLikeGitLab, parseMrPath, type MrPageContext } from '@/lib/gitlab-page';
import { discoverReports, loadComparison, loadReports } from '@/lib/scan';
import { getSettings, settings, withDefaults, type Settings } from '@/lib/storage';
import type { WidgetState } from '@/lib/types';
import './widget.css';

interface Store {
  state: WidgetState;
  settings: Settings;
}

/** One merge request's worth of work, so a soft navigation can cancel it. */
interface Session {
  page: MrPageContext;
  abort: AbortController;
  store: Store;
  ui: IntegratedContentScriptUi<App<Element>> | null;
  /** Set once the reports are in, so the comparison can start or be retried. */
  info: MrInfo | null;
  comparing: boolean;
}

export default defineContentScript({
  // gitlab.com is declared here; self-managed instances are registered at
  // runtime by the background script once the user grants access to them.
  matches: ['*://gitlab.com/*'],
  runAt: 'document_idle',

  async main(ctx) {
    const initial = await getSettings();
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
      if (session?.page.iid === page.iid) {
        log('already handling merge request', page.iid);
        return;
      }

      teardown();
      log('handling merge request', page.iid, 'in', page.pathPrefix);

      const active: Session = {
        page,
        abort: new AbortController(),
        store: reactive<Store>({
          state: { status: 'loading', reportTypes: [] },
          settings: await getSettings(),
        }) as Store,
        ui: null,
        info: null,
        comparing: false,
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
    let applied = initial;
    settings.watch((value) => {
      const next = withDefaults(value);
      const previous = applied;
      applied = next;

      setVerbose(next.verboseLogging);
      if (!session) return;
      session.store.settings = next;

      // Turning the comparison on or off should not require a reload, and nor
      // should raising how many base pipelines it may try — that is a request to
      // have another go. Every other setting is a pure re-filter of what is
      // already rendered and must not re-issue the comparison's requests:
      // without this an unrelated tweak retries a comparison that already
      // concluded it had no base to use. (`childPipelineDepth` is left out
      // deliberately — it also governs the head pipeline's discovery, which has
      // already happened, so it takes effect on the next page load.)
      const affectsComparison =
        next.compareWithTargetBranch !== previous.compareWithTargetBranch ||
        next.maxBasePipelines !== previous.maxBasePipelines;
      if (!affectsComparison) return;
      if (next.compareWithTargetBranch) void compare(session);
      else dropComparison(session);
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
  const outcome = await discoverReports(page, session.store.settings);
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
  session.info = discovery.info;

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
    if (signal.aborted) return;

    log(`rendered ${result.findings.length} finding(s)`, result.counts);
    session.store.state = {
      status: 'ok',
      result: {
        ...result,
        comparison: session.store.settings.compareWithTargetBranch
          ? { status: 'loading' }
          : { status: 'off' },
      },
    };
  } catch (cause) {
    logError('failed to download the reports', cause);
    if (!signal.aborted) {
      session.store.state = {
        status: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return;
  }

  // Phase three, unawaited: the findings are on screen and the comparison costs
  // a second pipeline's worth of requests, so nothing waits for it.
  void compare(session);
}

/** Clears the labels when the user turns the comparison off. */
function dropComparison(session: Session): void {
  const { state } = session.store;
  if (state.status !== 'ok' || state.result.comparison.status === 'off') return;
  session.store.state = { status: 'ok', result: { ...state.result, comparison: { status: 'off' } } };
}

/**
 * Compares the rendered findings against the target branch, in place.
 *
 * Safe to call more than once — it returns early unless there is a rendered
 * result without a comparison, which is what lets the settings watcher start one
 * when the user turns the feature on. A previous `unavailable` is retried on that
 * path, since switching the feature back on is a request to try again; the
 * watcher is what keeps unrelated settings changes off it.
 */
async function compare(session: Session): Promise<void> {
  const { state } = session.store;
  if (session.comparing || !session.info) return;
  if (!session.store.settings.compareWithTargetBranch) return;
  if (state.status !== 'ok') return;
  if (state.result.comparison.status === 'ready') return;

  session.comparing = true;
  const { signal } = session.abort;
  const result = state.result;

  try {
    if (result.comparison.status !== 'loading') {
      session.store.state = { status: 'ok', result: { ...result, comparison: { status: 'loading' } } };
    }

    const comparison = await loadComparison(
      session.page,
      session.info,
      result,
      session.store.settings,
    );
    // The user may have turned the comparison off while it was in flight.
    if (signal.aborted || !session.store.settings.compareWithTargetBranch) return;

    if (comparison.status === 'unavailable') log('no comparison:', comparison.reason);
    session.store.state = { status: 'ok', result: { ...result, comparison } };
  } catch (cause) {
    logError('failed to compare with the target branch', cause);
    if (!signal.aborted) {
      session.store.state = {
        status: 'ok',
        result: {
          ...result,
          comparison: {
            status: 'unavailable',
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        },
      };
    }
  } finally {
    session.comparing = false;
  }
}

async function mountWidget(
  ctx: ContentScriptContext,
  signal: AbortSignal,
  store: Store,
): Promise<IntegratedContentScriptUi<App<Element>> | null> {
  const anchor = await waitForAnchor(signal);
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
      const app = createApp(() => h(SecurityWidget, { state: store.state, settings: store.settings }));
      app.mount(container);
      return app;
    },
    onRemove(app) {
      app?.unmount();
    },
  });

  ui.mount();
  fitHost(ui.wrapper);
  log('widget mounted', anchor.append, anchor.selector);
  return ui;
}
