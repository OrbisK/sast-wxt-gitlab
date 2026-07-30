# Contributing

See the [README](README.md) for what the extension does and the endpoint chain it walks to find
reports. This file covers working on it.

## Development

```sh
pnpm dev              # Chrome, with HMR — needs an interactive terminal
pnpm dev:firefox
pnpm compile          # vue-tsc typecheck
pnpm test             # vitest
pnpm build            # pnpm build:firefox for the Firefox target
pnpm zip
```

`pnpm compile` and `pnpm test` are what CI gates on, so run both before opening a pull request.

### Testing against a real instance

`pnpm dev` launches Chrome with a **fresh temporary profile**, which is not signed in to your
GitLab. An anonymous request to a merge request URL redirects to `/users/sign_in`, so the extension
sees a path that is not a merge request and correctly does nothing. For anything involving real
data, use the production build in the profile where your GitLab session lives:

```sh
pnpm build
# chrome://extensions -> Developer mode -> Load unpacked -> .output/chrome-mv3
```

Then on your instance: extension icon → **Enable on this instance** → **Reload tab**.

Note also that `pnpm dev` waits on stdin for its `o + enter` shortcut, so it exits immediately if
started without an interactive terminal.

## Layout

| Path | What it does |
| --- | --- |
| `entrypoints/gitlab-mr.content/` | Content script: detects the MR page, orchestrates the scan, mounts the widget |
| `entrypoints/background.ts` | Registers the content script for user-added instances |
| `entrypoints/popup/`, `entrypoints/options/` | Instance list and display settings |
| `lib/gitlab-page.ts` | MR URL parsing and relative-URL-root handling |
| `lib/gitlab-api.ts` | The endpoint chain in the README, artifact download, gunzip |
| `lib/reports.ts` | Normalizes the GitLab security report schema (v2 through v15) into `Finding`s |
| `lib/scan.ts` | Two-phase scan: discover, then download |
| `lib/anchor.ts` | Where the widget is grafted onto the page |
| `components/SastWidget.vue` | The widget itself |

## Injection point

The widget is inserted **before `#js-vue-mr-widget`**, the element GitLab's own MR widget Vue app
mounts into. That puts it at the top of the widget stack while keeping our node in the
server-rendered parent, which Vue does not manage and so will not patch away. `lib/anchor.ts` falls
back through `#widget-state`, `.mr-state-widget`, `.merge-request-overview` and
`.merge-request-details` for older or restructured layouts.

Styling is deliberately *not* in a shadow root: the widget reads GitLab's own theme tokens
(`--gl-background-color-section` and friends, GitLab 17+) so it matches light and dark themes, with
hardcoded fallbacks for older versions. Every class is `glsw-` prefixed to avoid collisions.

## Releasing

Releases are driven by the `version` field in `package.json` — WXT copies it into the manifest, so
there is no second place to keep in sync. Bump it, merge to `main`, and
`.github/workflows/release.yml` does the rest: type check, test, zip both targets, attach the zips
to a `v<version>` GitHub release, then submit to whichever stores have credentials.

The path filter alone would fire on every dependency bump, so the first job compares `version`
against `HEAD~1` and the release job only runs when it actually changed.

Store submission is skipped when its secrets are absent, so the workflow is useful before either
store listing exists — you still get a GitHub release with installable zips, and a run summary
saying which stores were skipped. To enable them, set repository secrets:

| Store | Secrets |
| --- | --- |
| Chrome Web Store | `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` |
| Firefox Add-ons | `FIREFOX_EXTENSION_ID`, `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET` |

`pnpm exec wxt submit init` walks through obtaining these, and `--dry-run` checks the credentials
without uploading anything.

Two things must change before the first store release:

- `version` is `0.0.0`. A store listing needs a real version.
- the Firefox extension id in `wxt.config.ts` is the placeholder `sast-widget-for-gitlab@local`. It
  has to be the id registered on AMO, and `FIREFOX_EXTENSION_ID` has to match it.

Release notes come from GitHub's own generated notes (`gh release create --generate-notes`) rather
than [changelogithub](https://github.com/antfu/changelogithub), because this repository's commit
subjects are prose rather than Conventional Commits and changelogithub groups by `feat:`/`fix:`
prefixes — it would produce a near-empty changelog here. If you adopt Conventional Commits, swap
that one step for `pnpm dlx changelogithub`.

## Store listing requirements

GitLab's [trademark guidelines](https://handbook.gitlab.com/handbook/marketing/brand-and-product-marketing/brand/brand-activation/trademark-guidelines/)
govern what a third-party extension may be called. A Chrome Web Store or AMO listing must therefore:

- keep a name that does not lead with "GitLab" and uses only the `… for GitLab` or `GitLab
  Compatible` form — hence **SAST Widget for GitLab**;
- carry the non-affiliation notice at the top of the README in the listing's overview text;
- use no GitLab logo, logomark or wordmark, in the icon or the screenshots. The current
  `public/icon/*.png` is a generic puzzle piece.
