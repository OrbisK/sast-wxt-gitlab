import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SastWidget from './SastWidget.vue';
import { parseReport } from '@/lib/reports';
import { compareReports } from '@/lib/compare';
import { countBySeverity } from '@/lib/severity';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/storage';
import type { BasePipeline, ComparisonState, ParsedReport, ScanResult } from '@/lib/types';

function report(vulnerabilities: unknown[]): ParsedReport {
  const jobWebUrl = 'https://gitlab.example/g/p/-/jobs/7';
  return parseReport({ vulnerabilities }, {
    reportType: 'sast',
    jobId: 7,
    jobName: 'semgrep-sast',
    jobWebUrl,
    downloadUrl: `${jobWebUrl}/artifacts/download?file_type=sast`,
  });
}

const base: BasePipeline = {
  strategy: 'merge-base',
  pipelineId: 55,
  pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/55',
  targetBranch: 'main',
  sha: 'abcdef1234567890',
  commitWebUrl: 'https://gitlab.example/g/p/-/commit/abcdef1234567890',
};

/** A widget rendered from head reports, optionally compared with base ones. */
async function render(
  head: ParsedReport[],
  options: { base?: ParsedReport[]; comparison?: ComparisonState; settings?: Partial<Settings> } = {},
): Promise<string> {
  const findings = head.flatMap((report) => report.findings);
  const comparison: ComparisonState = options.base
    ? { status: 'ready', comparison: { base, ...compareReports(head, options.base) } }
    : (options.comparison ?? { status: 'off' });

  const result: ScanResult = {
    reports: head,
    findings,
    counts: countBySeverity(findings),
    pipelineId: 99,
    pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/99',
    comparison,
  };

  return renderToString(
    createSSRApp(() =>
      h(SastWidget, {
        state: { status: 'ok', result },
        settings: { ...DEFAULT_SETTINGS, startCollapsed: false, ...options.settings },
      }),
    ),
  );
}

const sqlInjection = {
  name: 'Possible SQL injection',
  severity: 'high',
  identifiers: [{ type: 'semgrep_id', name: 'rules.sql-injection', value: 'sql-injection' }],
  location: { file: 'app/db.rb', start_line: 12 },
};
const hardcodedSecret = { name: 'Hardcoded secret', severity: 'critical' };

describe('SastWidget header', () => {
  it('is green only when there is nothing to report', async () => {
    const html = await render([report([])]);

    expect(html).toContain('glsw-tone-success');
    expect(html).toContain('detected no vulnerabilities');
  });

  it('stays amber for findings this merge request did not introduce', async () => {
    const html = await render([report([sqlInjection])], { base: [report([sqlInjection])] });

    expect(html).toContain('glsw-tone-warning');
    expect(html).not.toContain('glsw-tone-success');
    expect(html).toContain('No new vulnerabilities, 1 already on main');
  });

  it('still shows the severity of findings that are not new', async () => {
    const html = await render([report([sqlInjection])], { base: [report([sqlInjection])] });

    expect(html).toContain('already there:');
    expect(html).toContain('glsw-sev-high');
  });

  it('turns red when the merge request adds a finding', async () => {
    const html = await render([report([sqlInjection, hardcodedSecret])], {
      base: [report([sqlInjection])],
    });

    expect(html).toContain('glsw-tone-danger');
    expect(html).toContain('This merge request adds 1 potential vulnerability');
    // The new finding is counted apart from the pre-existing one.
    expect(html).toContain('new:');
    expect(html).toContain('already there:');
    expect(html).toContain('glsw-badge-new');
  });

  it('links the commit it compared against', async () => {
    const html = await render([report([sqlInjection])], { base: [report([sqlInjection])] });

    expect(html).toContain('Compared with main at');
    expect(html).toContain(`href="${base.commitWebUrl}"`);
    // Abbreviated, as GitLab shows shas.
    expect(html).toContain('>abcdef12<');
  });

  it('says what it could not compare instead of calling it new', async () => {
    const html = await render([report([sqlInjection])], {
      base: [{ ...report([]), error: { kind: 'expired', message: 'gone' } }],
    });

    expect(html).toContain('could not be compared with main');
    expect(html).toContain('not compared');
    expect(html).not.toContain('glsw-badge-new');
    // Unknown is not a clean bill of health.
    expect(html).toContain('glsw-tone-warning');
  });

  it('keeps the plain totals while the comparison is still running', async () => {
    const html = await render([report([sqlInjection])], { comparison: { status: 'loading' } });

    expect(html).toContain('Security scanning detected 1 potential vulnerability');
    expect(html).toContain('Comparing with the target branch…');
    expect(html).toContain('glsw-tone-warning');
  });

  it('gives the reason when no base could be established', async () => {
    const html = await render([report([sqlInjection])], {
      comparison: { status: 'unavailable', reason: 'main has no finished pipeline' },
    });

    expect(html).toContain('Not compared with the target branch');
    expect(html).toContain('main has no finished pipeline');
    expect(html).not.toContain('glsw-badge-new');
  });

  it('lists what the merge request fixed', async () => {
    const html = await render([report([sqlInjection])], {
      base: [report([sqlInjection, hardcodedSecret])],
    });

    expect(html).toContain('Fixed by this merge request');
    expect(html).toContain('glsw-badge-fixed');
    expect(html).toContain('1 fixed here');
  });

  it('hides pre-existing findings on request, but never uncomparable ones', async () => {
    const html = await render([report([sqlInjection, hardcodedSecret])], {
      base: [report([sqlInjection])],
      settings: { showOnlyNew: true },
    });

    expect(html).toContain('Hardcoded secret');
    expect(html).not.toContain('Possible SQL injection');
    expect(html).toContain('1 hidden by filters');
  });

  it('stays amber when show-only-new is what emptied the list', async () => {
    // Nothing is on screen, but the findings are still in the code under review:
    // a green check here would be the filter congratulating the reader.
    const html = await render([report([sqlInjection])], {
      base: [report([sqlInjection])],
      settings: { showOnlyNew: true },
    });

    expect(html).toContain('glsw-tone-warning');
    expect(html).not.toContain('glsw-tone-success');
    expect(html).toContain('No new vulnerabilities, 1 already on main');
    // …and the pills keep saying what is there, even with the list hiding it.
    expect(html).toContain('already there:');
    expect(html).toContain('glsw-sev-high');
    expect(html).not.toContain('above your severity filter');
  });

  it('names the report type it could not compare', async () => {
    const html = await render([report([sqlInjection])], {
      base: [{ ...report([]), error: { kind: 'expired', message: 'gone' } }],
    });

    expect(html).toContain('1 not compared (SAST)');
  });

  it('is still green when show-only-new has nothing to hide', async () => {
    const html = await render([report([])], {
      base: [report([])],
      settings: { showOnlyNew: true },
    });

    expect(html).toContain('glsw-tone-success');
  });
});
