import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

export default defineConfig({
  // WxtVitest supplies the aliases and globals; the Vue plugin is what lets the
  // widget's own SFC be rendered in a test rather than only reasoned about.
  plugins: [vue(), WxtVitest()],
});
