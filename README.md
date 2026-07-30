# SAST Widget for GitLab

> This extension is not affiliated, endorsed, sponsored, or approved with or by GitLab Inc.
> GitLab is a trademark of GitLab Inc.

A browser extension that summarizes the security report artifacts your **merge request** pipeline
already produces, on instances where those reports are otherwise reachable only as raw JSON
downloads.

It finds the security report artifacts attached to the merge request's head pipeline, downloads
them with your existing GitLab session, and renders a summary above the merge widget.

It shows you what your own pipeline wrote and your own session can already fetch — it adds no data
and unlocks no reports. Scanners whose CI templates are subscription-gated never run in the first
place, so there is nothing for the widget to read; where a scanner does run, its artifact is served
to you by the same route GitLab's own "Download results" button uses.

## How it finds the reports

Report-type artifacts (`artifacts:reports:sast` and friends) are stored separately from the
artifacts archive, so the Job Artifacts API returns `404` for them and they do not appear under
`artifacts:paths`. They *are* served by the web download route, keyed by artifact type — the same
route GitLab's own "Download results" button uses:

```
GET /:namespace/:project/-/jobs/:job_id/artifacts/download?file_type=sast
```

The chain the content script walks:

1. `GET {project}/-/merge_requests/{iid}/cached_widget.json` → head pipeline id, `diff_head_sha`,
   target project id.
2. `GET {project}/-/merge_requests/{iid}.json?serializer=widget` → the project's full path. This
   is what lets us locate `/api/v4` on instances served under a relative URL root.
3. `GET /api/v4/projects/{id}/pipelines/{pipeline}/jobs` → jobs whose `artifacts[].file_type` is a
   security report type. One level of child pipelines is followed via `.../bridges`.
4. `GET {job.web_url}/artifacts/download?file_type={type}` per report. Report artifacts are stored
   gzipped, so the response is gunzipped in the browser when the gzip magic bytes are present.

All requests are same-origin from the content script, which is what makes the `_gitlab_session`
cookie ride along — a background-worker fetch would be cross-site and unauthenticated.

Supported report types: SAST, secret detection, dependency scanning, container scanning, cluster
image scanning, DAST, API fuzzing, coverage fuzzing.

Several jobs can declare the same report type, and each gets its own section. GitLab's IaC scanning
(`iac-sast`, KICS) declares `artifacts:reports:sast` exactly as its code scanning (`semgrep-sast`)
does, so both appear, told apart by the analyzer name and job link in the section heading.

## Permissions

`gitlab.com` is granted at install time. Self-managed instances are opt-in: open the popup on your
instance and choose **Enable on this instance**, or add it from the options page. That requests an
optional host permission and registers the content script for it at runtime.

Nothing is sent anywhere — reports are read from your instance and rendered locally.

Request volume per merge request page view is bounded: two widget JSON reads, at most five pages of
100 jobs per pipeline (plus one level of child pipelines), and one download per report artifact
found. Reports are fetched once per page load, not polled.

## Publishing

GitLab's [trademark guidelines](https://handbook.gitlab.com/handbook/marketing/brand-and-product-marketing/brand/brand-activation/trademark-guidelines/)
govern what a third-party extension may be called. A Chrome Web Store or AMO listing must therefore:

- keep a name that does not lead with "GitLab" and uses only the `… for GitLab` or `GitLab
  Compatible` form — hence **SAST Widget for GitLab**;
- carry the non-affiliation notice at the top of this file in the listing's overview text;
- use no GitLab logo, logomark or wordmark, in the icon or the screenshots. The current
  `public/icon/*.png` is a generic puzzle piece.

## Development

```sh
pnpm dev              # Chrome, with HMR — needs an interactive terminal
pnpm dev:firefox
pnpm compile          # vue-tsc typecheck
pnpm test             # vitest
pnpm build            # pnpm build:firefox for the Firefox target
pnpm zip
```

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

## Troubleshooting

The decision-level trail is always logged at `console.debug`, which Chrome hides behind the
console's **Verbose** level — switch that on and reload. Look for:

| Console output | Meaning |
| --- | --- |
| *(nothing at all)* | The content script never ran. Check the popup's **Diagnostics** section, then **Repair registration**. |
| `content script active on …` | It ran. The next line says what it decided. |
| `inactive: not a merge request page` | The path is not `/-/merge_requests/:iid` — usually a redirect to the sign-in page. |
| `inactive: could not read the merge request widget data: …` | `cached_widget.json` or the widget serializer failed; the message says how. |
| `inactive: this merge request has no head pipeline` | Nothing to scan. |
| `inactive: pipeline N has no security report artifacts` | The preceding line lists every job and its artifact types, so an unrecognized type is visible. |
| `inactive: found nothing on the page to attach the widget to` | Every selector in `lib/anchor.ts` missed. |

**Settings → Log each step to the page console** adds a line per HTTP request and per downloaded
artifact on top of that.

## Layout

| Path | What it does |
| --- | --- |
| `entrypoints/gitlab-mr.content/` | Content script: detects the MR page, orchestrates the scan, mounts the widget |
| `entrypoints/background.ts` | Registers the content script for user-added instances |
| `entrypoints/popup/`, `entrypoints/options/` | Instance list and display settings |
| `lib/gitlab-page.ts` | MR URL parsing and relative-URL-root handling |
| `lib/gitlab-api.ts` | Endpoint chain above, artifact download, gunzip |
| `lib/reports.ts` | Normalizes the GitLab security report schema (v2 through v15) into `Finding`s |
| `lib/scan.ts` | Two-phase scan: discover, then download |
| `lib/anchor.ts` | Where the widget is grafted onto the page |
| `components/SastWidget.vue` | The widget itself |

### Injection point

The widget is inserted **before `#js-vue-mr-widget`**, the element GitLab's own MR widget Vue app
mounts into. That puts it at the top of the widget stack while keeping our node in the
server-rendered parent, which Vue does not manage and so will not patch away. `lib/anchor.ts` falls
back through `#widget-state`, `.mr-state-widget`, `.merge-request-overview` and
`.merge-request-details` for older or restructured layouts.

Styling is deliberately *not* in a shadow root: the widget reads GitLab's own theme tokens
(`--gl-background-color-section` and friends, GitLab 17+) so it matches light and dark themes, with
hardcoded fallbacks for older versions. Every class is `glsw-` prefixed to avoid collisions.

## Known limits

- **Head pipeline only.** GitLab Ultimate reports "new vs. existing" by comparing the head pipeline
  against the target branch's last completed pipeline. This shows everything the head pipeline
  found. That comparison is the natural next step: fetch the base pipeline's reports the same way
  and diff on `Finding.key`.
- Requires the REST API to be reachable at `/api/v4` with your session.
- Only the first 500 jobs of a pipeline are scanned (5 pages of 100).
