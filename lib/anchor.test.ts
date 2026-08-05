// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitHost, findAnchor, waitForAnchor } from './anchor';

/** Just enough of the merge request page for the anchors to have somewhere to be. */
function page(discussion: string): string {
  return `
    <div class="merge-request-details issuable-details">
      <div class="merge-request-overview">
        <section>${discussion}</section>
        <aside class="right-sidebar"></aside>
      </div>
    </div>`;
}

/** GitLab's widget app once it has rendered, reports section and all. */
const READY = `
  <div class="issuable-discussion js-vue-notes-event">
    <div class="detail-page-description"></div>
    <h2 id="merge-request-widgets-heading" class="gl-sr-only">Merge request reports</h2>
    <div id="widget-state" class="mr-state-widget gl-mt-5">
      <div class="mr-section-container" data-testid="pipeline-container"></div>
      <section class="mr-section-container" data-testid="mr-widget-app"
               aria-label="Merge request reports"></section>
    </div>
    <div id="notes"></div>
  </div>`;

/** The app's root is up, but the reports section inside it is not. */
const HALF_BUILT = `
  <div class="issuable-discussion js-vue-notes-event">
    <div id="widget-state" class="mr-state-widget gl-mt-5">
      <div class="mr-section-container" data-testid="pipeline-container"></div>
    </div>
  </div>`;

/** Before the notes app has rendered anything at all. */
const EMPTY = '';

/** Real patience is measured in seconds; tests are not. */
const FAST = { patienceMs: [20, 20] };

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.useRealTimers();
});

describe('findAnchor', () => {
  it('prefers the reports section to the widget stack around it', () => {
    document.body.innerHTML = page(READY);
    expect(findAnchor()).toMatchObject({
      selector: '[data-testid="mr-widget-app"]',
      append: 'before',
      tier: 0,
    });
  });

  it('lands inside the widget stack, among GitLab’s own cards', () => {
    document.body.innerHTML = page(READY);
    const anchor = findAnchor()!;
    expect(anchor.element.parentElement?.id).toBe('widget-state');
  });

  it('falls back to the app root when the reports section is missing', () => {
    document.body.innerHTML = page(HALF_BUILT);
    expect(findAnchor()).toMatchObject({ selector: '#widget-state', append: 'before', tier: 1 });
  });

  it('takes the mount point while it still exists', () => {
    document.body.innerHTML = page('<div id="js-vue-mr-widget"></div>');
    expect(findAnchor()).toMatchObject({ selector: '#js-vue-mr-widget', append: 'before', tier: 1 });
  });

  it('never lands in the overview grid itself', () => {
    document.body.innerHTML = page(EMPTY);
    const anchor = findAnchor();
    expect(anchor?.tier).toBe(2);
    // The regression: the overview is a two-column grid holding the discussion
    // and the sidebar, so a third child of it breaks the whole page.
    expect((anchor?.element as HTMLElement).className).not.toContain('merge-request-overview');
    expect(anchor).toMatchObject({ selector: '.merge-request-overview > section', append: 'first' });
  });
});

describe('waitForAnchor', () => {
  it('resolves immediately when the reports section is already there', async () => {
    document.body.innerHTML = page(READY);
    await expect(waitForAnchor(new AbortController().signal)).resolves.toMatchObject({
      selector: '[data-testid="mr-widget-app"]',
      tier: 0,
    });
  });

  it('holds out for the reports section rather than taking the app root', async () => {
    document.body.innerHTML = page(HALF_BUILT);

    const pending = waitForAnchor(new AbortController().signal, { patienceMs: [10_000, 10_000] });
    document.querySelector('#widget-state')!.insertAdjacentHTML(
      'beforeend',
      '<section data-testid="mr-widget-app"></section>',
    );

    await expect(pending).resolves.toMatchObject({ tier: 0 });
  });

  it('holds out for the widget stack rather than taking a container', async () => {
    vi.useFakeTimers();
    // The containers are on the page from the start; the stack renders late. This
    // is the ordering that broke the layout.
    document.body.innerHTML = page(EMPTY);

    const pending = waitForAnchor(new AbortController().signal, { patienceMs: [20, 10_000] });
    await vi.advanceTimersByTimeAsync(30);
    document.querySelector('.merge-request-overview > section')!.innerHTML = HALF_BUILT;
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({ selector: '#widget-state', tier: 1 });
  });

  it('settles for the app root once the reports section fails to show', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = page(HALF_BUILT);

    const pending = waitForAnchor(new AbortController().signal, FAST);
    await vi.advanceTimersByTimeAsync(30);

    await expect(pending).resolves.toMatchObject({ selector: '#widget-state', tier: 1 });
  });

  it('settles for a container only once every better tier has run out', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = page(EMPTY);

    const pending = waitForAnchor(new AbortController().signal, FAST);

    // Tier 1's patience has not elapsed yet, so nothing has been accepted.
    await vi.advanceTimersByTimeAsync(30);
    await expect(Promise.race([pending, 'unresolved'])).resolves.toBe('unresolved');

    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({
      selector: '.merge-request-overview > section',
      tier: 2,
    });
  });

  it('gives up after the overall timeout', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div>not a merge request page</div>';

    const pending = waitForAnchor(new AbortController().signal, { ...FAST, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves to nothing when the session is aborted', async () => {
    document.body.innerHTML = page(EMPTY);
    const controller = new AbortController();
    const pending = waitForAnchor(controller.signal, { patienceMs: [10_000, 10_000] });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});

/** The host as WXT mounts it: a bare wrapper around the widget's own root. */
const HOST = '<div id="host"><section class="glsw"></section></div>';

/** Mounts a host inside a container of `style` and fits it, returning the host. */
function fit(style: string): HTMLElement {
  document.body.innerHTML = `<div style="${style}">${HOST}</div>`;
  const host = document.querySelector<HTMLElement>('#host')!;
  fitHost(host);
  return host;
}

/** Stands in for GitLab's stylesheet having a rule for its card class. */
function styleGitLabCards(): void {
  document.head.innerHTML = '<style>.mr-section-container { border-top-style: solid }</style>';
}

describe('fitHost', () => {
  it('makes the widget span a grid parent', () => {
    expect(fit('display: grid').style.gridColumn).toBe('1 / -1');
  });

  it('gives the widget its own line in a flex row', () => {
    expect(fit('display: flex').style.flex).toBe('1 1 100%');
  });

  it('does not stretch the widget in a block container', () => {
    const host = fit('');
    expect(host.style.gridColumn).toBe('');
    expect(host.style.flex).toBe('');
  });

  it('does not stretch the widget in a flex column', () => {
    const host = fit('display: flex; flex-direction: column');
    expect(host.style.gridColumn).toBe('');
    expect(host.style.flex).toBe('');
  });
});

describe('fitHost card', () => {
  it('dresses the host as one of GitLab’s cards', () => {
    styleGitLabCards();
    expect(fit('').classList.contains('mr-section-container')).toBe(true);
  });

  it('drops the widget’s own frame so the two do not double up', () => {
    // The regression: our frame carried a bottom margin of its own, which landed
    // on top of the spacing GitLab had already given the card.
    styleGitLabCards();
    expect(fit('').querySelector('.glsw')!.classList.contains('glsw-bare')).toBe(true);
  });

  it('keeps the widget’s own frame when GitLab’s class comes to nothing', () => {
    const host = fit('');
    expect(host.classList.contains('mr-section-container')).toBe(false);
    expect(host.querySelector('.glsw')!.classList.contains('glsw-bare')).toBe(false);
  });
});
