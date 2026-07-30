/**
 * Everything we need to know from the page itself, derived without touching
 * page JavaScript (content scripts run in an isolated world, so `gon` and the
 * Vue app's internals are off limits).
 */
export interface MrPageContext {
  /**
   * Path prefix up to but excluding `/-/merge_requests/`, e.g.
   * "/group/sub/project". On instances served under a relative URL root this
   * includes that root, which is exactly what we want for building same-origin
   * URLs by hand.
   */
  pathPrefix: string;
  /** Merge request iid from the URL. */
  iid: number;
}

const MR_PATH = /^(.*?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/;

/**
 * Parses an MR URL. Returns null for anything that is not a merge request
 * *page* — the MR list, `/-/merge_requests/new`, and unrelated paths all miss.
 */
export function parseMrPath(pathname: string): MrPageContext | null {
  const match = MR_PATH.exec(pathname);
  if (!match) return null;

  const [, pathPrefix, iid] = match;
  // A project path needs at least a namespace and a project.
  if (pathPrefix.split('/').filter(Boolean).length < 2) return null;

  return { pathPrefix, iid: Number(iid) };
}

/**
 * Cheap sanity check that we are actually on a GitLab page, so the extension
 * stays inert if a user adds a host that turns out not to be GitLab.
 */
export function looksLikeGitLab(doc: Document = document): boolean {
  return Boolean(
    doc.querySelector('meta[content="GitLab"]') ||
      doc.querySelector('meta[name="csrf-param"]') ||
      doc.querySelector('body[data-page]') ||
      doc.querySelector('.js-merge-request-details, .merge-request, #js-vue-mr-widget'),
  );
}

/**
 * Splits a page path prefix into the instance's relative URL root and the
 * project's full path, given the full path reported by GitLab itself.
 *
 * "/gitlab/group/proj" + "group/proj" -> { relativeRoot: "/gitlab", ... }
 */
export function splitRelativeRoot(
  pathPrefix: string,
  projectFullPath: string,
): { relativeRoot: string; projectFullPath: string } {
  const suffix = `/${projectFullPath}`;
  const relativeRoot = pathPrefix.endsWith(suffix)
    ? pathPrefix.slice(0, pathPrefix.length - suffix.length)
    : '';
  return { relativeRoot, projectFullPath };
}
