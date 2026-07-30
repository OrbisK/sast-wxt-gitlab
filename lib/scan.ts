import {
  discoverReportSources,
  fetchMrInfo,
  downloadReportJson,
  HttpError,
  type MrInfo,
} from './gitlab-api';
import { log } from './debug';
import type { MrPageContext } from './gitlab-page';
import { parseReport } from './reports';
import { compareFindings, countBySeverity } from './severity';
import {
  SECURITY_REPORT_TYPES,
  type ParsedReport,
  type ReportError,
  type ReportSource,
  type ScanResult,
} from './types';

export interface Discovery {
  info: MrInfo;
  sources: ReportSource[];
}

export type DiscoveryOutcome =
  /** Not an MR we understand, or it has no pipeline — stay invisible. */
  | { status: 'not-applicable'; reason: string }
  /** A pipeline exists but we could not enumerate its artifacts. Worth showing. */
  | { status: 'error'; message: string }
  | { status: 'found'; discovery: Discovery };

/**
 * Phase one: work out whether this merge request has security reports at all.
 *
 * Split from the download step so the widget can appear with a loading state as
 * soon as we know there is something to show, without flashing on merge
 * requests that have no security scanning.
 *
 * Failures are classified rather than thrown: a merge request whose widget data
 * we cannot read is almost certainly not our business, whereas a pipeline whose
 * jobs we cannot list points at a real problem (API disabled, missing scope)
 * that the user should see.
 */
export async function discoverReports(page: MrPageContext): Promise<DiscoveryOutcome> {
  let info: MrInfo;
  try {
    info = await fetchMrInfo(page.pathPrefix, page.iid);
  } catch (error) {
    return {
      status: 'not-applicable',
      reason: `could not read the merge request widget data: ${describe(error)}`,
    };
  }

  if (!info.pipelineId) {
    return { status: 'not-applicable', reason: 'this merge request has no head pipeline' };
  }

  try {
    const sources = await discoverReportSources(info, info.pipelineId);
    return { status: 'found', discovery: { info, sources } };
  } catch (error) {
    return {
      status: 'error',
      message: `Could not list the pipeline's job artifacts: ${describe(error)}`,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a failed artifact download into something worth reading.
 *
 * A 404 here is nearly always an expired artifact: we only ask for URLs the
 * jobs API just listed, and GitLab erases the file while the job itself stays.
 * The list can also simply be stale — artifacts erased between the listing and
 * the download, or unlocked by a newer pipeline mid-session — so the wording is
 * hedged unless `artifacts_expire_at` is a date that has actually passed.
 *
 * Other 404 causes exist (a job in a fork the user cannot read, say), which is
 * the other reason not to state expiry as fact without a date to back it.
 */
export function describeDownloadFailure(error: unknown, source: ReportSource, now: Date): ReportError {
  if (!(error instanceof HttpError) || error.status !== 404) {
    return { kind: 'unavailable', message: describe(error) };
  }

  const expiredOn = pastExpiry(source.artifactsExpireAt, now);
  return {
    kind: 'expired',
    message: expiredOn
      ? `The report artifact expired on ${expiredOn} and is no longer stored.`
      : 'The report artifact is no longer available — it has most likely expired.',
  };
}

/** Formats `artifacts_expire_at` only if it parses and is in the past. */
function pastExpiry(value: string | undefined, now: Date): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) return null;
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Phase two: download and normalize each report.
 *
 * A failure to read one report does not fail the scan — that report carries an
 * `error` and the others are still shown.
 */
export async function loadReports(
  page: MrPageContext,
  { info, sources }: Discovery,
): Promise<ScanResult> {
  const blobUrl = info.diffHeadSha
    ? (file: string, line?: number) => buildBlobUrl(page.pathPrefix, info.diffHeadSha!, file, line)
    : undefined;

  const reports = await Promise.all(
    sources.map(async (source): Promise<ParsedReport> => {
      try {
        const raw = await downloadReportJson(source.downloadUrl);
        return parseReport(raw, source, { blobUrl });
      } catch (cause) {
        const failure = describeDownloadFailure(cause, source, new Date());
        log(
          `could not read ${source.reportType} from job ${source.jobName}#${source.jobId}:`,
          `${failure.kind} —`,
          failure.message,
        );
        return {
          reportType: source.reportType,
          source,
          scanners: [],
          findings: [],
          error: failure,
        };
      }
    }),
  );

  // Group by report type, then by job name so the several jobs that can share a
  // type (semgrep-sast and iac-sast, say) keep a stable order between reloads.
  reports.sort((a, b) => {
    const byType =
      SECURITY_REPORT_TYPES.indexOf(a.reportType) - SECURITY_REPORT_TYPES.indexOf(b.reportType);
    return byType !== 0 ? byType : a.source.jobName.localeCompare(b.source.jobName);
  });

  const findings = reports.flatMap((report) => report.findings).sort(compareFindings);

  return {
    reports,
    findings,
    counts: countBySeverity(findings),
    pipelineId: info.pipelineId!,
    pipelineWebUrl: info.pipelineWebUrl,
  };
}

function buildBlobUrl(
  pathPrefix: string,
  sha: string,
  file: string,
  line: number | undefined,
): string {
  // Encode each path segment but keep the separators intact.
  const encoded = file
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const anchor = line ? `#L${line}` : '';
  return `${pathPrefix}/-/blob/${sha}/${encoded}${anchor}`;
}
