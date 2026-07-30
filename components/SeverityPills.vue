<script setup lang="ts">
import { computed } from 'vue';
import { SEVERITIES, SEVERITY_LABELS, type SeverityCounts } from '@/lib/types';

const props = defineProps<{ counts: SeverityCounts }>();

const present = computed(() =>
  SEVERITIES.filter((severity) => props.counts[severity] > 0).map((severity) => ({
    severity,
    label: SEVERITY_LABELS[severity],
    count: props.counts[severity],
  })),
);
</script>

<template>
  <ul v-if="present.length" class="glsw-pills">
    <li v-for="pill in present" :key="pill.severity" :class="`glsw-pill glsw-sev-${pill.severity}`">
      <span class="glsw-pill-dot" aria-hidden="true" />
      <span class="glsw-pill-count">{{ pill.count }}</span>
      <span class="glsw-pill-label">{{ pill.label }}</span>
    </li>
  </ul>
</template>
