import { describe, expect, it } from 'vitest';
import { parseMrPath, splitRelativeRoot } from './gitlab-page';

describe('parseMrPath', () => {
  it('parses a merge request page', () => {
    expect(parseMrPath('/group/project/-/merge_requests/42')).toEqual({
      pathPrefix: '/group/project',
      iid: 42,
    });
  });

  it('parses nested namespaces', () => {
    expect(parseMrPath('/group/sub/team/project/-/merge_requests/7/diffs')).toEqual({
      pathPrefix: '/group/sub/team/project',
      iid: 7,
    });
  });

  it('keeps a relative URL root in the prefix', () => {
    expect(parseMrPath('/gitlab/group/project/-/merge_requests/1')).toEqual({
      pathPrefix: '/gitlab/group/project',
      iid: 1,
    });
  });

  it.each([
    '/group/project/-/merge_requests',
    '/group/project/-/merge_requests/new',
    '/group/project/-/issues/5',
    '/dashboard/merge_requests',
    '/-/merge_requests/3',
  ])('ignores %s', (path) => {
    expect(parseMrPath(path)).toBeNull();
  });
});

describe('splitRelativeRoot', () => {
  it('finds no root when the prefix is exactly the project path', () => {
    expect(splitRelativeRoot('/group/project', 'group/project')).toEqual({
      relativeRoot: '',
      projectFullPath: 'group/project',
    });
  });

  it('extracts the instance relative root', () => {
    expect(splitRelativeRoot('/gitlab/group/project', 'group/project')).toEqual({
      relativeRoot: '/gitlab',
      projectFullPath: 'group/project',
    });
  });

  it('falls back to no root when the paths disagree', () => {
    expect(splitRelativeRoot('/group/project', 'other/project').relativeRoot).toBe('');
  });
});
