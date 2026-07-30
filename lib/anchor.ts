import { bail, log } from './debug';

/**
 * Where to graft the widget onto the merge request page.
 *
 * `#js-vue-mr-widget` is the element GitLab's own MR widget Vue app mounts
 * into, so inserting *before* it puts our widget at the top of the widget stack
 * while leaving our node in the statically rendered parent that Vue does not
 * manage. The rest are fallbacks for older or restructured layouts.
 */
const ANCHOR_SELECTORS = [
  '#js-vue-mr-widget',
  '#widget-state',
  '.mr-state-widget',
  '.merge-request-overview',
  '.merge-request-details',
  '.merge-request',
] as const;

/** Selectors we insert *into* (as the first child) rather than before. */
const PREPEND_SELECTORS = new Set<string>([
  '.merge-request-overview',
  '.merge-request-details',
  '.merge-request',
]);

export interface ResolvedAnchor {
  element: Element;
  append: 'before' | 'first';
  /** Which selector matched, for diagnostics. */
  selector: string;
}

export function findAnchor(root: ParentNode = document): ResolvedAnchor | undefined {
  for (const selector of ANCHOR_SELECTORS) {
    const element = root.querySelector(selector);
    if (element) {
      return {
        element,
        append: PREPEND_SELECTORS.has(selector) ? 'first' : 'before',
        selector,
      };
    }
  }
  return undefined;
}

/**
 * Resolves as soon as an anchor appears. The MR widget mount point is rendered
 * server-side, but tab switches and soft navigations can replace it, so callers
 * that need to remount await this again.
 */
export function waitForAnchor(
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<ResolvedAnchor | undefined> {
  const immediate = findAnchor();
  if (immediate) {
    log('anchor found immediately:', immediate.selector);
    return Promise.resolve(immediate);
  }

  log('waiting for one of', ANCHOR_SELECTORS.join(', '));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ResolvedAnchor | undefined) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);

      if (value) log('anchor appeared:', value.selector);
      resolve(value);
    };

    const observer = new MutationObserver(() => {
      const anchor = findAnchor();
      if (anchor) finish(anchor);
    });
    const timer = setTimeout(() => {
      bail(`no anchor matched after ${timeoutMs}ms`, ANCHOR_SELECTORS);
      finish(undefined);
    }, timeoutMs);
    const onAbort = () => finish(undefined);

    signal.addEventListener('abort', onAbort, { once: true });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}
