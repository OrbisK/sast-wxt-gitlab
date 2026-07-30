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
   * Log each step to the page console. Always on in dev builds; this only
   * affects production builds.
   */
  verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  startCollapsed: true,
  minSeverity: 'unknown',
  hideLikelyFalsePositives: false,
  verboseLogging: false,
};

export const settings = storage.defineItem<Settings>('sync:settings', {
  fallback: DEFAULT_SETTINGS,
});

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
