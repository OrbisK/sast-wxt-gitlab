<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import FindingItem from './FindingItem.vue';
import SeverityPills from './SeverityPills.vue';
import { countBySeverity, severityRank } from '@/lib/severity';
import type { Settings } from '@/lib/storage';
import { REPORT_TYPE_LABELS, type Finding, type ParsedReport, type WidgetState } from '@/lib/types';

const props = defineProps<{ state: WidgetState; settings: Settings }>();

const PAGE_SIZE = 20;

const collapsed = ref(props.settings.startCollapsed);
const shownPerReport = ref<Record<string, number>>({});

/** Reports keep their own findings so each section can be filtered and paged. */
interface ReportSection {
  /** Per-job, not per-type: several jobs can report the same type. */
  key: string;
  report: ParsedReport;
  label: string;
  findings: Finding[];
  hiddenByFilter: number;
}

function keepFinding(finding: Finding): boolean {
  if (props.settings.hideLikelyFalsePositives && finding.likelyFalsePositive) return false;
  return severityRank(finding.severity) <= severityRank(props.settings.minSeverity);
}

const result = computed(() => (props.state.status === 'ok' ? props.state.result : null));

const sections = computed<ReportSection[]>(() =>
  (result.value?.reports ?? []).map((report) => {
    const findings = report.findings.filter(keepFinding);
    return {
      key: `${report.source.jobId}:${report.reportType}`,
      report,
      label: REPORT_TYPE_LABELS[report.reportType],
      findings,
      hiddenByFilter: report.findings.length - findings.length,
    };
  }),
);

const visibleFindings = computed(() => sections.value.flatMap((section) => section.findings));
const visibleCounts = computed(() => countBySeverity(visibleFindings.value));

const failedReports = computed(() =>
  (result.value?.reports ?? []).filter((report) => report.error),
);

const totalHiddenByFilter = computed(() =>
  sections.value.reduce((sum, section) => sum + section.hiddenByFilter, 0),
);

const summary = computed(() => {
  if (props.state.status === 'loading') return 'Reading security scan results…';
  if (props.state.status === 'error') return 'Could not read security scan results';

  const total = visibleCounts.value.total;
  if (total === 0) {
    return totalHiddenByFilter.value > 0
      ? 'Security scanning detected no vulnerabilities above your severity filter'
      : 'Security scanning detected no vulnerabilities';
  }
  return `Security scanning detected ${total} potential ${total === 1 ? 'vulnerability' : 'vulnerabilities'}`;
});

const tone = computed(() => {
  if (props.state.status === 'loading') return 'neutral';
  if (props.state.status === 'error') return 'danger';
  if (failedReports.value.length) return 'warning';
  return visibleCounts.value.total > 0 ? 'warning' : 'success';
});

// Two jobs of the same type (semgrep-sast and iac-sast) would otherwise read as
// "SAST, SAST" here; the per-section headings below tell them apart instead.
const scannedLabel = computed(() => {
  const labels =
    props.state.status === 'loading'
      ? props.state.reportTypes.map((type) => REPORT_TYPE_LABELS[type])
      : sections.value.map((section) => section.label);
  return [...new Set(labels)].join(', ');
});

function shownCount(section: ReportSection): number {
  return shownPerReport.value[section.key] ?? PAGE_SIZE;
}

function showMore(section: ReportSection): void {
  shownPerReport.value = {
    ...shownPerReport.value,
    [section.key]: shownCount(section) + PAGE_SIZE,
  };
}

// Reset paging when the filter changes so "show more" state cannot outlive it.
watch(
  () => [props.settings.minSeverity, props.settings.hideLikelyFalsePositives],
  () => {
    shownPerReport.value = {};
  },
);

const isCollapsible = computed(
  () => props.state.status === 'ok' && (visibleFindings.value.length > 0 || failedReports.value.length > 0),
);
</script>

<template>
  <section class="glsw" :class="`glsw-tone-${tone}`" data-testid="gitlab-sast-widget">
    <div class="glsw-head">
      <span class="glsw-status" aria-hidden="true">
        <svg
          v-if="state.status === 'loading'"
          class="glsw-spin"
          viewBox="0 0 16 16"
          width="16"
          height="16"
        >
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-dasharray="28 12" />
        </svg>
        <svg v-else-if="tone === 'success'" viewBox="0 0 16 16" width="16" height="16">
          <path
            fill="currentColor"
            d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.7 6.1-4.2 4.2a1 1 0 0 1-1.4 0L4.3 8.5a1 1 0 0 1 1.4-1.4l1.1 1.1 3.5-3.5a1 1 0 0 1 1.4 1.4Z"
          />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="16" height="16">
          <path
            fill="currentColor"
            d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm1 11.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM7 4a1 1 0 0 1 2 0v4.5a1 1 0 0 1-2 0V4Z"
          />
        </svg>
      </span>

      <div class="glsw-head-body">
        <p class="glsw-summary">{{ summary }}</p>

        <p v-if="state.status === 'error'" class="glsw-sub glsw-danger-text">
          {{ state.message }}
        </p>

        <SeverityPills v-else-if="state.status === 'ok'" :counts="visibleCounts" />

        <p class="glsw-sub">
          <span v-if="scannedLabel">{{ scannedLabel }}</span>
          <template v-if="result?.pipelineWebUrl">
            <span v-if="scannedLabel"> · </span>
            <a class="glsw-link" :href="result.pipelineWebUrl">pipeline #{{ result.pipelineId }}</a>
          </template>
          <template v-if="totalHiddenByFilter > 0">
            · <span class="glsw-muted">{{ totalHiddenByFilter }} hidden by filter</span>
          </template>
        </p>
      </div>

      <button
        v-if="isCollapsible"
        type="button"
        class="glsw-toggle"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? 'Show details' : 'Hide details' }}
      </button>
    </div>

    <div v-if="state.status === 'ok' && !collapsed" class="glsw-body">
      <div v-for="section in sections" :key="section.key" class="glsw-section">
        <div class="glsw-section-head">
          <span class="glsw-section-title">{{ section.label }}</span>
          <span v-if="section.report.scanners.length" class="glsw-muted">
            {{ section.report.scanners.join(', ') }}
          </span>
          <span class="glsw-spacer" />
          <a class="glsw-link" :href="section.report.source.jobWebUrl">
            {{ section.report.source.jobName }}
          </a>
          <a class="glsw-link" :href="section.report.source.downloadUrl" download>raw JSON</a>
        </div>

        <p v-if="section.report.error" class="glsw-sub glsw-danger-text">
          {{ section.report.error }}
        </p>

        <p v-else-if="!section.findings.length" class="glsw-sub glsw-muted">
          No findings{{ section.hiddenByFilter ? ' above your severity filter' : '' }}.
        </p>

        <ul v-else class="glsw-findings">
          <FindingItem
            v-for="finding in section.findings.slice(0, shownCount(section))"
            :key="finding.key"
            :finding="finding"
          />
        </ul>

        <button
          v-if="section.findings.length > shownCount(section)"
          type="button"
          class="glsw-more"
          @click="showMore(section)"
        >
          Show {{ Math.min(PAGE_SIZE, section.findings.length - shownCount(section)) }} more of
          {{ section.findings.length }}
        </button>
      </div>
    </div>
  </section>
</template>
