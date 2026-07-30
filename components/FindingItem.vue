<script setup lang="ts">
import { computed, ref } from 'vue';
import { SEVERITY_LABELS, type Finding } from '@/lib/types';

const props = defineProps<{ finding: Finding }>();

const expanded = ref(false);

const location = computed(() => {
  const { file, startLine, dependency, locationLabel } = props.finding;
  if (file) return startLine ? `${file}:${startLine}` : file;
  return dependency ?? locationLabel;
});

const hasDetail = computed(() =>
  Boolean(
    props.finding.description ||
      props.finding.solution ||
      props.finding.links.length ||
      props.finding.identifiers.length,
  ),
);
</script>

<template>
  <li class="glsw-finding">
    <div class="glsw-finding-head">
      <span
        :class="`glsw-sev-tag glsw-sev-${finding.severity}`"
        :title="`Severity: ${SEVERITY_LABELS[finding.severity]}`"
      >
        {{ SEVERITY_LABELS[finding.severity] }}
      </span>

      <div class="glsw-finding-main">
        <button
          v-if="hasDetail"
          type="button"
          class="glsw-finding-name glsw-linkish"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ finding.name }}
        </button>
        <span v-else class="glsw-finding-name">{{ finding.name }}</span>

        <span v-if="finding.likelyFalsePositive" class="glsw-flag" title="Flagged by the scanner">
          likely false positive
        </span>

        <div v-if="location" class="glsw-finding-location">
          <a v-if="finding.blobUrl" :href="finding.blobUrl" class="glsw-link">{{ location }}</a>
          <span v-else>{{ location }}</span>
          <span v-if="finding.scanner" class="glsw-muted"> · {{ finding.scanner }}</span>
        </div>
      </div>
    </div>

    <div v-if="expanded" class="glsw-finding-detail">
      <p v-if="finding.description" class="glsw-detail-text">{{ finding.description }}</p>

      <p v-if="finding.solution" class="glsw-detail-text">
        <strong>Solution:</strong> {{ finding.solution }}
      </p>

      <ul v-if="finding.identifiers.length" class="glsw-ident-list">
        <li v-for="identifier in finding.identifiers" :key="identifier" class="glsw-ident">
          {{ identifier }}
        </li>
      </ul>

      <ul v-if="finding.links.length" class="glsw-link-list">
        <li v-for="link in finding.links" :key="link.url">
          <a :href="link.url" class="glsw-link" target="_blank" rel="noreferrer noopener">
            {{ link.name || link.url }}
          </a>
        </li>
      </ul>
    </div>
  </li>
</template>
