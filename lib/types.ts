/**
 * GitLab CI artifact `file_type` values that hold a security report, in the
 * order we want to present them. These map 1:1 onto `artifacts:reports:<type>`
 * keys in .gitlab-ci.yml and onto `?file_type=` on the artifact download route.
 */
export const SECURITY_REPORT_TYPES = [
  'sast',
  'secret_detection',
  'dependency_scanning',
  'container_scanning',
  'cluster_image_scanning',
  'dast',
  'api_fuzzing',
  'coverage_fuzzing',
] as const;

export type ReportType = (typeof SECURITY_REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  sast: 'SAST',
  secret_detection: 'Secret detection',
  dependency_scanning: 'Dependency scanning',
  container_scanning: 'Container scanning',
  cluster_image_scanning: 'Cluster image scanning',
  dast: 'DAST',
  api_fuzzing: 'API fuzzing',
  coverage_fuzzing: 'Coverage fuzzing',
};

export function isSecurityReportType(value: string): value is ReportType {
  return (SECURITY_REPORT_TYPES as readonly string[]).includes(value);
}

/** Severity levels as used by the GitLab security report schema, worst first. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'] as const;

export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
  unknown: 'Unknown',
};

/** A single job artifact that we can download a security report from. */
export interface ReportSource {
  reportType: ReportType;
  jobId: number;
  jobName: string;
  /** Absolute URL of the job, e.g. https://gitlab.example/group/proj/-/jobs/42 */
  jobWebUrl: string;
  /** Absolute URL the raw report JSON is downloaded from. */
  downloadUrl: string;
}

/** One normalized vulnerability, flattened out of a report's own schema. */
export interface Finding {
  reportType: ReportType;
  severity: Severity;
  name: string;
  description?: string;
  scanner?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  /** Link into the repository at the reported file/line, when resolvable. */
  blobUrl?: string;
  /** e.g. "CWE-79", "CVE-2021-1234", "A03:2021" */
  identifiers: string[];
  solution?: string;
  links: { name?: string; url: string }[];
  /** Dependency scanning / container scanning only. */
  dependency?: string;
  /** Fallback location text for report types with no file, such as DAST. */
  locationLabel?: string;
  /** True when the scanner flagged this as a likely false positive. */
  likelyFalsePositive: boolean;
  /** Stable-ish key, used for dedupe and (later) new-vs-existing diffing. */
  key: string;
}

/** Everything one report artifact contributed. */
export interface ParsedReport {
  reportType: ReportType;
  source: ReportSource;
  scanners: string[];
  findings: Finding[];
  /** Set when the artifact was found but could not be read. */
  error?: string;
}

export interface SeverityCounts extends Record<Severity, number> {
  total: number;
}

export interface ScanResult {
  reports: ParsedReport[];
  findings: Finding[];
  counts: SeverityCounts;
  pipelineId: number;
  pipelineWebUrl?: string;
}

/** What the injected widget is currently displaying. */
export type WidgetState =
  | { status: 'loading'; reportTypes: ReportType[] }
  | { status: 'error'; message: string }
  | { status: 'ok'; result: ScanResult };
