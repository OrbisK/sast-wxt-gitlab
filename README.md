# SAST Widget for GitLab

> [!WARNING]
> Early work in progress. It works, and it is not settled: expect breaking changes, no upgrade path
> between versions, and rough edges on GitLab layouts it has not been tried against. It reads your
> reports and renders them — that part is safe by construction — but do not treat what it shows as a
> complete picture of your security posture yet. Bug reports with a `console.debug` trail are welcome.

> [!IMPORTANT]
> This extension is not affiliated, endorsed, sponsored, or approved with or by GitLab Inc.
> GitLab is a trademark of GitLab Inc.

A browser extension that summarizes the security report artifacts your **merge request** pipeline
already produces, on instances where those reports are otherwise reachable only as raw JSON
downloads.

It finds the security report artifacts attached to the merge request's head pipeline, downloads
them with your existing GitLab session, and renders a summary above the merge widget.

## Why

On GitLab Free and Premium, two things are true at once: your pipeline finds vulnerabilities, and
your merge request never mentions them.

[SAST](https://docs.gitlab.com/user/application_security/sast/) and
[pipeline secret detection](https://docs.gitlab.com/user/application_security/secret_detection/pipeline/)
are available in every tier — the templates run, the analyzers report what they find, and the
findings land in a report artifact. Displaying those findings is the separately priced part.
GitLab's own comparison tables put the downloadable JSON report under Free and Premium, and "new
findings in merge request reports" under Ultimate.

So the data is already there and your session can already fetch it; reading it is what costs. A
reviewer has to notice that some job produced an artifact, open that job, download a JSON file, and
read it — once per scanner, on every merge request. At that price nobody does it, and a finding
nobody reads protects nothing. Scanning in CI is only worth the minutes it burns if the results
reach the review, which is exactly where they stop being free.

It shows you what your own pipeline wrote and your own session can already fetch — it adds no data
and unlocks no reports. Scanners whose CI templates are subscription-gated never run in the first
place, so there is nothing for the widget to read; where a scanner does run, its artifact is served
to you by the same route GitLab's own "Download results" button uses.

## Before and after

One Free-tier project, one merge request, one pipeline running SAST and secret detection. The only
difference between the two screenshots is whether the extension is installed — neither is Ultimate.

**Free tier, without the extension** — the pipeline is green and the page says nothing about what
the scanners found. The report artifacts exist, but reaching them means opening the job and
downloading the JSON.

![A merge request on a Free-tier GitLab project without the extension: the merge widget reports a
passed pipeline, and no security findings appear anywhere on the page](.github/assets/before.png)

**Free tier, with the extension** — same project, same pipeline, same session. The findings the
artifacts already contained, grouped by report type and severity, above the merge widget.

![The same Free-tier merge request with the extension installed: a security summary above the merge
widget listing findings by severity, grouped per report type](.github/assets/after.png)

## Install

> [!NOTE]
> No store listing yet, so there is no auto-update — you reinstall to upgrade.

Grab the zip for your browser from the [latest release](../../releases/latest) and load it unpacked:

- **Chrome** — unzip it, then `chrome://extensions` → Developer mode → **Load unpacked**
- **Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**

`gitlab.com` works immediately. For a self-managed instance, open the extension icon on that
instance and choose **Enable on this instance**, then reload the tab.

## What it shows

Supported report types: SAST, secret detection, dependency scanning, container scanning, cluster
image scanning, DAST, API fuzzing, coverage fuzzing.

Several jobs can declare the same report type, and each gets its own section. GitLab's IaC scanning
(`iac-sast`, KICS) declares `artifacts:reports:sast` exactly as its code scanning (`semgrep-sast`)
does, so both appear, told apart by the analyzer name and job link in the section heading.

Findings can be filtered by severity, and scanner-flagged likely false positives hidden, from the
options page.

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

## Permissions and privacy

`gitlab.com` is granted at install time. Self-managed instances are opt-in: open the popup on your
instance and choose **Enable on this instance**, or add it from the options page. That requests an
optional host permission and registers the content script for it at runtime.

> [!NOTE]
> Nothing is sent anywhere — reports are read from your instance and rendered locally.

Request volume per merge request page view is bounded: two widget JSON reads, at most five pages of
100 jobs per pipeline (plus one level of child pipelines), and one download per report artifact
found. Reports are fetched once per page load, not polled.

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
| `inactive: pipeline N has no security report artifacts` | The preceding line lists every job and its artifact types, so an unrecognized type is visible. Fully erased artifacts drop out of the jobs API, so an old merge request whose artifacts expired lands here. |
| `could not read sast from job X#N: expired — …` | The job still lists the artifact but the download 404s, so the file itself is gone. That report's section says so and the others still render. |
| `inactive: found nothing on the page to attach the widget to` | Every selector in `lib/anchor.ts` missed. |

> [!TIP]
> **Settings → Log each step to the page console** adds a line per HTTP request and per downloaded
> artifact on top of that.

## Known limits

- **Head pipeline only.** GitLab Ultimate reports "new vs. existing" by comparing the head pipeline
  against the target branch's last completed pipeline. This shows everything the head pipeline
  found. That comparison is the natural next step: fetch the base pipeline's reports the same way
  and diff on `Finding.key`.
- Requires the REST API to be reachable at `/api/v4` with your session.
- Only the first 500 jobs of a pipeline are scanned (5 pages of 100).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, how the code is laid out, and the
release process.
