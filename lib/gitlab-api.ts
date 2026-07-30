import { isSecurityReportType, type ReportSource, type ReportType } from './types';
import { splitRelativeRoot } from './gitlab-page';
import { log, trace } from './debug';

/**
 * All requests here are same-origin and rely on the user's existing
 * `_gitlab_session` cookie, which is why they run in the content script rather
 * than the background worker: a background fetch would be cross-site and
 * GitLab's session cookie would not ride along.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });

  trace('GET', url, '->', response.status, response.headers.get('content-type'));

  if (!response.ok) {
    throw new HttpError(`GET ${url} failed`, response.status, url);
  }

  // A signed-out session or an unexpected route answers with an HTML page, and
  // `response.json()` would fail with an opaque SyntaxError.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new Error(`GET ${url} returned ${contentType || 'an unknown content type'}, not JSON`);
  }

  return (await response.json()) as T;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(`${message} (HTTP ${status})`);
    this.name = 'HttpError';
  }
}

interface CachedWidgetResponse {
  target_project_id?: number;
  diff_head_sha?: string | null;
  pipeline?: { id?: number; path?: string } | null;
}

interface WidgetResponse {
  target_project_full_path?: string;
  source_project_full_path?: string;
  /** Present on EE; a map of report type -> enabled. Purely a hint for us. */
  enabled_reports?: Record<string, boolean>;
}

interface JobArtifact {
  file_type: string;
  filename?: string;
  file_format?: string | null;
  size?: number;
}

interface Job {
  id: number;
  name: string;
  web_url: string;
  artifacts?: JobArtifact[] | null;
}

interface Bridge {
  downstream_pipeline?: { id: number; project_id: number } | null;
}

export interface MrInfo {
  pipelineId: number | null;
  pipelineWebUrl?: string;
  diffHeadSha?: string;
  projectId: number;
  projectFullPath: string;
  relativeRoot: string;
  apiBase: string;
  enabledReports?: Record<string, boolean>;
}

/**
 * Resolves the head pipeline plus enough project identity to talk to the REST
 * API. GitLab's internal MR JSON endpoints are used for this because they are
 * reachable purely from the page path, even under a relative URL root — the
 * project's full path they report is what lets us locate `/api/v4`.
 */
export async function fetchMrInfo(pathPrefix: string, iid: number): Promise<MrInfo> {
  const [cached, widget] = await Promise.all([
    fetchJson<CachedWidgetResponse>(`${pathPrefix}/-/merge_requests/${iid}/cached_widget.json`),
    fetchJson<WidgetResponse>(`${pathPrefix}/-/merge_requests/${iid}.json?serializer=widget`),
  ]);

  const projectFullPath = widget.target_project_full_path;
  if (!projectFullPath) {
    throw new Error('Could not determine the project path from the merge request widget data');
  }
  if (!cached.target_project_id) {
    throw new Error('Could not determine the project id from the merge request widget data');
  }

  const { relativeRoot } = splitRelativeRoot(pathPrefix, projectFullPath);
  const pipelineId = cached.pipeline?.id ?? null;

  log('merge request resolved', {
    projectFullPath,
    projectId: cached.target_project_id,
    pipelineId,
    relativeRoot: relativeRoot || '(none)',
    diffHeadSha: cached.diff_head_sha,
    enabledReports: widget.enabled_reports,
  });

  return {
    pipelineId,
    pipelineWebUrl: pipelineId ? `${pathPrefix}/-/pipelines/${pipelineId}` : undefined,
    diffHeadSha: cached.diff_head_sha ?? undefined,
    projectId: cached.target_project_id,
    projectFullPath,
    relativeRoot,
    apiBase: `${relativeRoot}/api/v4`,
    enabledReports: widget.enabled_reports,
  };
}

/** Follows `x-next-page` so large pipelines are covered, with a hard page cap. */
async function fetchPaginated<T>(url: string, maxPages = 5): Promise<T[]> {
  const results: T[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = page === 1 ? url : withQuery(url, { page: String(page) });
    const response = await fetch(pageUrl, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new HttpError(`GET ${pageUrl} failed`, response.status, pageUrl);
    }
    results.push(...((await response.json()) as T[]));

    if (!response.headers.get('x-next-page')) break;
  }

  return results;
}

function withQuery(url: string, params: Record<string, string>): string {
  const [base, search = ''] = url.split('?');
  const query = new URLSearchParams(search);
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  return `${base}?${query}`;
}

/**
 * Finds every job artifact in the pipeline (and one level of child pipelines)
 * that holds a security report.
 *
 * The download URL is built from the job's own `web_url`, so it stays correct
 * for jobs that live in a forked source project or under a relative URL root.
 */
export async function discoverReportSources(
  info: Pick<MrInfo, 'apiBase' | 'projectId'>,
  pipelineId: number,
): Promise<ReportSource[]> {
  const sources = await collectFromPipeline(info.apiBase, info.projectId, pipelineId, 1);
  const deduped = dedupeSources(sources);

  log(
    `pipeline ${pipelineId}: ${deduped.length} security report artifact(s)`,
    deduped.map((source) => `${source.reportType} (job ${source.jobName}#${source.jobId})`),
  );

  return deduped;
}

/**
 * More than one job legitimately produces the same report type, so the dedupe
 * key is the job rather than the type: GitLab's IaC scanning (`iac-sast`, KICS)
 * declares `artifacts:reports:sast` exactly like its code scanning
 * (`semgrep-sast`) does, and so does any hand-written scanner job. Keying on the
 * report type kept only whichever job came last and silently dropped the rest.
 *
 * Retried jobs are not a concern here: the pipeline jobs endpoint omits them
 * unless `include_retried=true`. What this does still collapse is the same job
 * seen twice, which happens when two bridges point at one downstream pipeline.
 */
export function dedupeSources(sources: ReportSource[]): ReportSource[] {
  const byJob = new Map<string, ReportSource>();
  for (const source of sources) byJob.set(`${source.jobId}:${source.reportType}`, source);
  return [...byJob.values()];
}

async function collectFromPipeline(
  apiBase: string,
  projectId: number,
  pipelineId: number,
  depthRemaining: number,
): Promise<ReportSource[]> {
  const jobsUrl = `${apiBase}/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`;
  const jobs = await fetchPaginated<Job>(jobsUrl);

  // Log every artifact type present, so a report type we failed to recognize is
  // visible rather than silently skipped.
  log(
    `pipeline ${pipelineId}: ${jobs.length} job(s)`,
    jobs.map(
      (job) =>
        `${job.name}#${job.id} [${(job.artifacts ?? []).map((a) => a.file_type).join(',') || 'no artifacts'}]`,
    ),
  );

  const sources: ReportSource[] = [];
  for (const job of jobs) {
    for (const artifact of job.artifacts ?? []) {
      if (!isSecurityReportType(artifact.file_type)) continue;
      sources.push({
        reportType: artifact.file_type,
        jobId: job.id,
        jobName: job.name,
        jobWebUrl: job.web_url,
        downloadUrl: artifactDownloadUrl(job.web_url, artifact.file_type),
      });
    }
  }

  if (depthRemaining > 0) {
    const bridges = await fetchPaginated<Bridge>(
      `${apiBase}/projects/${projectId}/pipelines/${pipelineId}/bridges?per_page=100`,
    ).catch(() => [] as Bridge[]);

    const children = bridges
      .map((bridge) => bridge.downstream_pipeline)
      .filter((pipeline): pipeline is { id: number; project_id: number } => Boolean(pipeline));

    const nested = await Promise.all(
      children.map((child) =>
        collectFromPipeline(apiBase, child.project_id, child.id, depthRemaining - 1).catch(
          () => [] as ReportSource[],
        ),
      ),
    );
    for (const list of nested) sources.push(...list);
  }

  return sources;
}

/**
 * Report-type artifacts are not part of the artifacts archive, so the archive
 * API returns 404 for them. The web download route does serve them, keyed by
 * `file_type` — this is the same route GitLab's own "Download results" button
 * uses.
 */
export function artifactDownloadUrl(jobWebUrl: string, fileType: ReportType): string {
  return `${jobWebUrl.replace(/\/+$/, '')}/artifacts/download?file_type=${fileType}`;
}

/**
 * Report artifacts are stored gzipped. Depending on the instance's storage and
 * proxy setup the browser may or may not have already decompressed them by the
 * time we see the body, so sniff the gzip magic bytes instead of assuming.
 */
export async function downloadReportJson(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new HttpError(`GET ${url} failed`, response.status, url);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = isGzip ? await gunzipToText(bytes) : new TextDecoder().decode(bytes);

  log('downloaded report', url, `${bytes.length} bytes`, isGzip ? '(gzip)' : '(plain)');

  return JSON.parse(text);
}

async function gunzipToText(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress gzipped artifacts');
  }
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
