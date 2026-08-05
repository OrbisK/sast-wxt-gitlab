/**
 * Diagnostics.
 *
 * Every path in this extension can legitimately decide to do nothing — no
 * pipeline, no security reports, no anchor on the page. Without a trace of
 * *which* of those happened, "no widget appeared" is indistinguishable from "the
 * content script never ran", so each decision point logs its reason.
 *
 * The decision-level trail (`log`, `bail`) is always emitted, at `console.debug`
 * level: Chrome hides that behind the console's "Verbose" filter, so it costs a
 * normal user nothing while staying available without a rebuild or a setting.
 * The chatty per-request trail (`trace`) is opt-in, since it is one line per
 * fetch.
 */
const PREFIX = '[gitlab-security]';

let verbose = Boolean(import.meta.env.DEV);

export function setVerbose(value: boolean): void {
  // Dev builds stay verbose regardless of the stored setting.
  verbose = value || Boolean(import.meta.env.DEV);
}

export function isVerbose(): boolean {
  return verbose;
}

/** Decision-level trail. Always emitted. Enable "Verbose" in DevTools to see it. */
export function log(...args: unknown[]): void {
  console.debug(PREFIX, ...args);
}

/** Records why we are intentionally rendering nothing. Always emitted. */
export function bail(reason: string, ...args: unknown[]): void {
  console.debug(`${PREFIX} inactive:`, reason, ...args);
}

/** Per-request detail. Opt-in via the "verbose logging" setting. */
export function trace(...args: unknown[]): void {
  if (verbose) console.debug(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
