import { SEVERITIES, type Severity, type SeverityCounts, type Finding } from './types';

export function normalizeSeverity(raw: unknown): Severity {
  const value = String(raw ?? '').toLowerCase();
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : 'unknown';
}

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 };
}

export function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts = emptyCounts();
  for (const finding of findings) {
    counts[finding.severity] += 1;
    counts.total += 1;
  }
  return counts;
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** Worst severity first, then grouped by file so related findings sit together. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;

  const byFile = (a.file ?? '').localeCompare(b.file ?? '');
  if (byFile !== 0) return byFile;

  return (a.startLine ?? 0) - (b.startLine ?? 0);
}

/** True when at least one severity at or above `threshold` is present. */
export function hasAtLeast(counts: SeverityCounts, threshold: Severity): boolean {
  return SEVERITIES.slice(0, severityRank(threshold) + 1).some((s) => counts[s] > 0);
}
