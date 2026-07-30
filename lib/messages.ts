/**
 * Popup <-> background messages.
 *
 * The popup asks the background to report and repair content script
 * registration, so that a host which was granted permission but never got a
 * script registered is visible in the UI rather than only in a service worker
 * log nobody opens.
 */
export interface RegistrationStatus {
  /** Match patterns we currently have a dynamic registration for. */
  registered: string[];
  /** Origins stored in settings. */
  configured: string[];
  /** Origins stored in settings whose host permission is missing. */
  missingPermission: string[];
  /** Set when the last registration attempt failed. */
  error?: string;
}

export type Request =
  /** Re-run registration and report the result. */
  | { type: 'sync-registration' }
  | { type: 'get-registration-status' };

export type Response = RegistrationStatus;
