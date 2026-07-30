import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // MV3 for both Chrome and Firefox so `optional_host_permissions` and
  // `scripting.registerContentScripts` behave the same way on each.
  manifestVersion: 3,
  manifest: {
    name: 'GitLab SAST widget',
    description:
      'Adds a security scan summary to GitLab merge requests on Free/CE, where the built-in security widget is not available.',
    permissions: ['storage', 'scripting', 'activeTab'],
    // gitlab.com is granted up front; self-managed instances are added by the
    // user from the options page and granted through the optional permission.
    host_permissions: ['*://gitlab.com/*'],
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'GitLab SAST widget',
    },
    // Firefox requires a stable extension id for MV3.
    browser_specific_settings: {
      gecko: {
        id: 'gitlab-sast-widget@local',
        strict_min_version: '128.0',
      },
    },
  },
});
