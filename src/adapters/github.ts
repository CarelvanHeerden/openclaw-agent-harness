/**
 * GitHub REST adapter for the ONE operation the harness performs: open a
 * pull request. Everything else (push, fetch) goes through git.
 *
 * We deliberately do NOT wrap the whole Octokit surface. The plugin should
 * touch as little of GitHub as possible.
 */

export interface CreatePrInput {
  repoFullName: string;
  head: string;           // branch name
  base: string;           // usually "main"
  title: string;
  body: string;
  ghToken: string;
  draft?: boolean;
}

export interface CreatePrOutput {
  number: number;
  htmlUrl: string;
  nodeId: string;
}

export async function createPullRequest(input: CreatePrInput): Promise<CreatePrOutput> {
  const url = `https://api.github.com/repos/${input.repoFullName}/pulls`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.ghToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-agent-harness/0.1",
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: !!input.draft,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR create failed ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { number: number; html_url: string; node_id: string };
  return {
    number: json.number,
    htmlUrl: json.html_url,
    nodeId: json.node_id,
  };
}

/**
 * Sanity-check that a PAT can see a repo. Used at session-start so we
 * fail fast with a clear Slack error instead of dying mid-worker.
 */
export async function verifyRepoAccess(input: { repoFullName: string; ghToken: string }): Promise<{ ok: boolean; status: number; scopes?: string; reason?: string }> {
  const url = `https://api.github.com/repos/${input.repoFullName}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${input.ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-agent-harness/0.1",
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, reason: (await res.text()).slice(0, 200) };
  }
  const scopes = res.headers.get("x-oauth-scopes") ?? undefined;
  return { ok: true, status: res.status, scopes };
}
