import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMrDiffRefs, findBasePipelines } from './gitlab-api';

const info = { apiBase: '/api/v4', projectId: 7 };

type Handler = (url: string) => unknown;

/**
 * Answers each request from `routes`, matched by substring on the URL. An
 * unmatched URL is a test bug, not a 404, so it throws.
 */
function stubFetch(routes: Record<string, Handler | unknown>): () => string[] {
  const seen: string[] = [];

  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(url);
    const match = Object.keys(routes).find((pattern) => url.includes(pattern));
    if (!match) throw new Error(`unexpected request: ${url}`);

    const route = routes[match];
    const body = typeof route === 'function' ? (route as Handler)(url) : route;
    if (body instanceof Error) throw body;

    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  });

  return () => seen;
}

function pipeline(id: number, status: string, sha = `sha${id}`) {
  return { id, status, sha, web_url: `https://gitlab.example/g/p/-/pipelines/${id}` };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMrDiffRefs', () => {
  it('reads the target branch and the merge base', async () => {
    stubFetch({
      '/merge_requests/41': {
        target_branch: 'main',
        diff_refs: { base_sha: 'abc123', head_sha: 'def456' },
      },
    });

    expect(await fetchMrDiffRefs(info, 41)).toEqual({ targetBranch: 'main', baseSha: 'abc123' });
  });

  it('tolerates a merge request with no diff refs', async () => {
    stubFetch({ '/merge_requests/41': { target_branch: 'main', diff_refs: null } });

    expect(await fetchMrDiffRefs(info, 41)).toEqual({ targetBranch: 'main', baseSha: undefined });
  });

  it('refuses to guess when no target branch comes back', async () => {
    stubFetch({ '/merge_requests/41': {} });

    await expect(fetchMrDiffRefs(info, 41)).rejects.toThrow(/target branch/);
  });
});

describe('findBasePipelines', () => {
  const refs = { targetBranch: 'main', baseSha: 'abc123' };

  it('puts the merge base ahead of the target branch tip', async () => {
    stubFetch({
      'sha=abc123': [pipeline(10, 'success')],
      'ref=main': [pipeline(30, 'success'), pipeline(20, 'failed')],
    });

    const { candidates } = await findBasePipelines(info, refs, 99);

    expect(candidates.map((c) => [c.pipelineId, c.strategy])).toEqual([
      [10, 'merge-base'],
      [30, 'target-branch'],
      [20, 'target-branch'],
    ]);
    expect(candidates[0]).toMatchObject({
      targetBranch: 'main',
      sha: 'sha10',
      pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/10',
    });
  });

  it('skips pipelines that have not finished', async () => {
    // A running pipeline may not have reached its scan jobs, and a base missing
    // half its findings would report the other half as newly introduced.
    stubFetch({
      'sha=abc123': [pipeline(12, 'running'), pipeline(11, 'pending'), pipeline(10, 'success')],
      'ref=main': [pipeline(30, 'created')],
    });

    const { candidates } = await findBasePipelines(info, refs, 99);
    expect(candidates.map((c) => c.pipelineId)).toEqual([10]);
  });

  it('falls back to the target branch when the merge base has no pipeline', async () => {
    stubFetch({ 'sha=abc123': [], 'ref=main': [pipeline(30, 'success')] });

    expect(await findBasePipelines(info, refs, 99)).toMatchObject({
      candidates: [{ pipelineId: 30, strategy: 'target-branch' }],
      failure: undefined,
    });
  });

  it('does not query the merge base when the merge request has none', async () => {
    const seen = stubFetch({ 'ref=main': [pipeline(30, 'success')] });

    await findBasePipelines(info, { targetBranch: 'main' }, 99);

    expect(seen().some((url) => url.includes('sha='))).toBe(false);
  });

  it('keeps the merge-base strategy for a pipeline both queries return', async () => {
    // The target branch has not moved since the merge request branched off it.
    stubFetch({ 'sha=abc123': [pipeline(10, 'success')], 'ref=main': [pipeline(10, 'success')] });

    expect((await findBasePipelines(info, refs, 99)).candidates).toMatchObject([
      { pipelineId: 10, strategy: 'merge-base' },
    ]);
  });

  it('never offers the head pipeline as its own base', async () => {
    stubFetch({ 'sha=abc123': [pipeline(10, 'success')], 'ref=main': [pipeline(10, 'success')] });

    expect((await findBasePipelines(info, refs, 10)).candidates).toEqual([]);
  });

  it('still falls back when the merge base lookup fails outright', async () => {
    stubFetch({ 'sha=abc123': new Error('boom'), 'ref=main': [pipeline(30, 'success')] });

    expect((await findBasePipelines(info, refs, 99)).candidates).toMatchObject([{ pipelineId: 30 }]);
  });

  it('reports no candidates rather than throwing when both lookups fail', async () => {
    stubFetch({ 'sha=abc123': new Error('boom'), 'ref=main': new Error('boom') });

    // The failure travels with the empty list: "we were not allowed to ask" and
    // "the branch has no pipeline" are the same empty list otherwise.
    expect(await findBasePipelines(info, refs, 99)).toMatchObject({
      candidates: [],
      failure: expect.stringContaining('boom'),
    });
  });

  it('does not blame the branch for a merge-base lookup that failed', async () => {
    stubFetch({ 'sha=abc123': new Error('boom'), 'ref=main': [] });

    expect((await findBasePipelines(info, refs, 99)).failure).toContain('boom');
  });
});
