import { bail, log } from './debug';

export interface AnchorRule {
  selector: string;
  /** Insert the widget before the match, or as its first child. */
  append: 'before' | 'first';
}

interface AnchorTier {
  /** For diagnostics. */
  name: string;
  /** How long to hold out for this tier before settling for the next one down. */
  patienceMs: number;
  rules: readonly AnchorRule[];
}

export interface ResolvedAnchor {
  element: Element;
  append: 'before' | 'first';
  /** Which selector matched, for diagnostics. */
  selector: string;
  /** Index into `TIERS`; 0 is the place we actually want to be. */
  tier: number;
}

/**
 * Where to graft the widget onto the merge request page, best first.
 *
 * GitLab builds this page out of several Vue apps that mount at different times,
 * so "which anchors exist" is a moving target and whichever one we happen to
 * catch decides where the widget ends up. Ranking them and holding out briefly
 * for a better one keeps that from being down to luck.
 */
const TIERS: readonly AnchorTier[] = [
  {
    /**
     * The reports section — the `aria-label="Merge request reports"` container.
     * It only exists once GitLab's widget app has rendered, so matching it is
     * proof the stack is ready rather than half-built, and inserting before it
     * drops our card in among GitLab's own pipeline, approvals and merge cards.
     *
     * That does mean sitting inside a Vue-rendered root, which is fine —
     * interleaved foreign nodes survive Vue's child patching, and every anchor
     * below is inside the notes app's root anyway.
     *
     * Matched by `data-testid`, not by `aria-label`: the label is translated and
     * would only ever match on an English instance.
     */
    name: 'reports section',
    patienceMs: 4_000,
    rules: [{ selector: '[data-testid="mr-widget-app"]', append: 'before' }],
  },
  {
    /**
     * The widget stack in its earlier states: the app's root, the mount point it
     * replaces on render, and the heading GitLab labels the stack with. Landing
     * here puts the widget above the stack rather than inside it — right area,
     * slightly higher — and it is the answer for a merge request whose stack
     * carries no reports section at all.
     */
    name: 'widget stack',
    patienceMs: 6_000,
    rules: [
      { selector: '#widget-state', append: 'before' },
      { selector: '.mr-state-widget', append: 'before' },
      { selector: '#js-vue-mr-widget', append: 'before' },
      { selector: '#merge-request-widgets-heading', append: 'before' },
    ],
  },
  {
    /**
     * Last resort, for a layout we no longer recognise. Every one of these has to
     * be a plain block container. `.merge-request-overview` is *not*: it is a
     * two-column grid whose children are the discussion column and the sidebar,
     * so inserting into it directly adds a third grid item and shunts the sidebar
     * onto a row of its own, wrecking the page. Hence `> section` — the
     * discussion column — rather than the grid itself.
     */
    name: 'page container',
    patienceMs: Infinity,
    rules: [
      { selector: '.issuable-discussion', append: 'first' },
      { selector: '.merge-request-overview > section', append: 'first' },
      { selector: '.merge-request-details', append: 'first' },
    ],
  },
];

/** The best anchor present in `root`, considering tiers 0 through `depth`. */
function match(root: ParentNode, depth: number): ResolvedAnchor | undefined {
  for (let tier = 0; tier <= depth; tier++) {
    for (const rule of TIERS[tier].rules) {
      const element = root.querySelector(rule.selector);
      if (element) return { element, append: rule.append, selector: rule.selector, tier };
    }
  }
  return undefined;
}

/**
 * Resolves the best anchor present right now, preferring a better tier over an
 * earlier one regardless of document order.
 */
export function findAnchor(root: ParentNode = document): ResolvedAnchor | undefined {
  return match(root, TIERS.length - 1);
}

export interface WaitForAnchorOptions {
  /** Per-tier hold-out, indexed to `TIERS`. Overridable so tests need not wait. */
  patienceMs?: readonly number[];
  timeoutMs?: number;
}

/**
 * Resolves as soon as a usable anchor appears, widening from the ideal anchor
 * through to the last resort as each tier's patience runs out.
 *
 * Taking whatever matched the moment it matched is what put the widget in the
 * overview grid and broke the layout: the containers were on the page from the
 * start while the widget stack was still being rendered by GitLab's notes app,
 * which on a heavy merge request can finish long after our own requests do.
 */
export function waitForAnchor(
  signal: AbortSignal,
  { patienceMs, timeoutMs = 30_000 }: WaitForAnchorOptions = {},
): Promise<ResolvedAnchor | undefined> {
  const patience = TIERS.map((tier, index) => patienceMs?.[index] ?? tier.patienceMs);

  const immediate = match(document, 0);
  if (immediate) {
    log('anchor found immediately:', immediate.selector);
    return Promise.resolve(immediate);
  }

  log(`waiting for the ${TIERS[0].name}`);

  return new Promise((resolve) => {
    let settled = false;
    let depth = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = (value: ResolvedAnchor | undefined) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);

      if (value) log('anchor appeared:', value.selector, `(${TIERS[value.tier].name})`);
      resolve(value);
    };

    const check = () => {
      const anchor = match(document, depth);
      if (anchor) finish(anchor);
    };

    const widen = () => {
      depth += 1;
      log(`no ${TIERS[depth - 1].name} yet; the ${TIERS[depth].name} will do`);
      check();
    };

    // One timer per tier boundary, at the running total of the patience above it.
    let at = 0;
    for (let tier = 0; tier + 1 < TIERS.length; tier++) {
      at += patience[tier];
      if (Number.isFinite(at)) timers.push(setTimeout(widen, at));
    }

    const observer = new MutationObserver(check);
    timers.push(
      setTimeout(() => {
        bail(`no anchor matched after ${timeoutMs}ms`, TIERS.flatMap((tier) => tier.rules));
        finish(undefined);
      }, timeoutMs),
    );
    const onAbort = () => finish(undefined);

    signal.addEventListener('abort', onAbort, { once: true });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

/** GitLab's own class for one card in the merge request widget stack. */
const CARD_CLASS = 'mr-section-container';

/**
 * Marks a host that is drawing the card itself, so the widget inside it drops
 * the frame it would otherwise draw for itself.
 *
 * It goes on the host rather than on the widget because the widget's root
 * carries a `:class` binding: Vue rewrites that element's whole `class`
 * attribute whenever the binding changes, which quietly takes any class of ours
 * with it the moment the reports land and the tone changes.
 */
const HOSTED_CLASS = 'glsw-hosted';

/**
 * Settles the widget's host into the container it landed in: what the card is
 * dressed as, and how it takes part in the container's layout.
 *
 * Only inline styles and classes the host owns are touched, so this leaves the
 * page alone in the ordinary case of a plain block container.
 */
export function fitHost(host: HTMLElement): void {
  dressAsCard(host);

  const parent = host.parentElement;
  if (!parent) return;

  // Belt and braces for the layout the tiers are meant to avoid: if the
  // container lays its children out in a row — a grid or a `row`-direction flex
  // box — a plain block host becomes one more cell and pushes the container's
  // real children out of place. Make it span the row instead.
  const { display, flexDirection } = getComputedStyle(parent);
  if (display === 'grid' || display === 'inline-grid') {
    host.style.gridColumn = '1 / -1';
    log('anchor parent is a grid; the widget spans every column');
  } else if ((display === 'flex' || display === 'inline-flex') && !flexDirection.startsWith('column')) {
    host.style.flex = '1 1 100%';
    log('anchor parent is a flex row; the widget takes a full line');
  }
}

/**
 * Hands the card's frame over to GitLab by putting its own card class on the
 * host, which is a direct sibling of GitLab's cards and so matches whatever
 * rules the stack uses.
 *
 * The point is the spacing. A margin of our own can only guess at the gap the
 * stack keeps between its cards, and guessed wrong: it landed on top of the
 * spacing GitLab had already applied, leaving the widget further from the card
 * below it than GitLab's cards are from each other. Border, corners and
 * background come along for the ride, and match by construction.
 *
 * Whether a stylesheet we do not control has a rule for that class is not
 * something we can know up front, so it is checked rather than assumed — a host
 * left without a border is proof there was no rule, and the widget keeps the
 * frame it draws for itself. That is the case on an instance too old for the
 * class, and on the fallback anchors outside the widget stack.
 */
function dressAsCard(host: HTMLElement): void {
  host.classList.add(CARD_CLASS);

  // The border's *style*, not its width: a bare element's computed width is the
  // `medium` keyword resolved to pixels, and only `border-style` reliably reads
  // as absent.
  if (getComputedStyle(host).borderTopStyle !== 'none') {
    host.classList.add(HOSTED_CLASS);
    log(`the host wears GitLab's own .${CARD_CLASS}`);
    return;
  }

  host.classList.remove(CARD_CLASS);
  log(`.${CARD_CLASS} is not styled here; the widget draws its own card`);
}
