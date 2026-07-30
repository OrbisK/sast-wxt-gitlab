import { discoverReportSources, fetchMrInfo, downloadReportJson, type MrInfo } from './gitlab-api';
import type { MrPageContext } from './gitlab-page';
import { parseReport } from './reports';
import { compareFindings, countBySeverity } from './severity';
import {
  SECURITY_REPORT_TYPES,
  type ParsedReport,
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
      } catch (error) {
        return {
          reportType: source.reportType,
          source,
          scanners: [],
          findings: [],
          error: error instanceof Error ? error.message : String(error),
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
