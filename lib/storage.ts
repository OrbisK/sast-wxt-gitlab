import { storage } from 'wxt/utils/storage';
import type { Severity } from './types';

/**
 * Extra GitLab origins the user has added (e.g. "https://gitlab.example.com").
 * gitlab.com is always enabled and is not stored here.
 */
export const instanceOrigins = storage.defineItem<string[]>('sync:instanceOrigins', {
  fallback: [],
});

export interface Settings {
  /** Start the widget collapsed rather than expanded. */
  startCollapsed: boolean;
  /** Hide findings below this severity. */
  minSeverity: Severity;
  /** Hide findings the scanner flagged as likely false positives. */
  hideLikelyFalsePositives: boolean;
  /**
   * Compare the head pipeline's findings against the target branch's, so new
   * findings can be told from ones the branch already had. Costs a second
   * pipeline's worth of requests, after the findings are already on screen.
   */
  compareWithTargetBranch: boolean;
  /**
   * Show only findings this merge request introduces. Findings that could not be
   * compared stay visible either way — hiding them would pass off "unknown" as
   * "already there".
   */
  showOnlyNew: boolean;
  /**
   * Log each step to the page console. Always on in dev builds; this only
   * affects production builds.
   */
  verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  startCollapsed: true,
  minSeverity: 'unknown',
  hideLikelyFalsePositives: false,
  compareWithTargetBranch: true,
  showOnlyNew: false,
  verboseLogging: false,
};

export const settings = storage.defineItem<Settings>('sync:settings', {
  fallback: DEFAULT_SETTINGS,
});

/**
 * The stored object predates whichever setting was added last, and a `fallback`
 * only covers the case where nothing is stored at all — so a key added in a
 * later version reads back as `undefined` for everyone who already has settings.
 * Every read goes through here.
 */
export function withDefaults(value: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(value ?? {}) };
}

export async function getSettings(): Promise<Settings> {
  return withDefaults(await settings.getValue());
}

/** Normalizes user input like "gitlab.example.com/" into an origin. */
export function toOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Match pattern covering a whole origin, for permissions and script registration. */
export function originToMatchPattern(origin: string): string {
  return `${origin}/*`;
}

export const GITLAB_COM_ORIGIN = 'https://gitlab.com';

export async function addOrigin(origin: string): Promise<string[]> {
  const current = await instanceOrigins.getValue();
  if (current.includes(origin) || origin === GITLAB_COM_ORIGIN) return current;

  const next = [...current, origin].sort();
  await instanceOrigins.setValue(next);
  return next;
}

export async function removeOrigin(origin: string): Promise<string[]> {
  const current = await instanceOrigins.getValue();
  const next = current.filter((o) => o !== origin);
  await instanceOrigins.setValue(next);
  return next;
}
