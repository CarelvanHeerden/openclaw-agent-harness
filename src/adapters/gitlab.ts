const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "User-Agent": "openclaw-agent-harness/control-plane" });
const project = (repo: string) => encodeURIComponent(repo);

export async function getGitLabRevision(input: { repoFullName: string; ref: string; token: string; apiBase: string; signal?: AbortSignal }): Promise<string> {
  const res = await fetch(`${input.apiBase}/projects/${project(input.repoFullName)}/repository/commits/${encodeURIComponent(input.ref)}`, { headers: headers(input.token), signal: input.signal });
  if (!res.ok) throw new Error(`GitLab get revision failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { id?: string };
  if (!body.id || !/^[a-f0-9]{40,64}$/i.test(body.id)) throw new Error("GitLab did not return a commit id");
  return body.id.toLowerCase();
}

export async function getGitLabMergeRequest(input: { repoFullName: string; prNumber: number; token: string; apiBase: string; signal?: AbortSignal }) {
  const res = await fetch(`${input.apiBase}/projects/${project(input.repoFullName)}/merge_requests/${input.prNumber}`, { headers: headers(input.token), signal: input.signal });
  if (!res.ok) throw new Error(`GitLab get MR !${input.prNumber} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json() as { sha:string;state:string;merged_at?:string|null;merge_commit_sha?:string|null;squash_commit_sha?:string|null;target_branch:string;source_branch:string;draft?:boolean;work_in_progress?:boolean;web_url?:string };
  return { headSha:j.sha,state:j.state === "opened" ? "open" : "closed",merged:!!j.merged_at,mergeCommitSha:j.merge_commit_sha??j.squash_commit_sha??null,mergeable:null,baseBranch:j.target_branch,headRepoFullName:input.repoFullName,headRef:j.source_branch,draft:!!(j.draft||j.work_in_progress),htmlUrl:j.web_url??"" };
}

export async function getGitLabCiSnapshot(input: { repoFullName:string; sha:string; token:string; apiBase:string; signal?:AbortSignal }): Promise<import("./github.js").CiSnapshot> {
  const res = await fetch(`${input.apiBase}/projects/${project(input.repoFullName)}/pipelines?sha=${encodeURIComponent(input.sha)}&per_page=100`, { headers:headers(input.token), signal:input.signal });
  if (!res.ok) return { state:"unknown" as const,statusReadable:false,checksReadable:false,statusState:"",statusCount:0,checkTotal:0,checkIncomplete:0,checkFailed:0,checkPassed:0,checkNames:[],reason:`gitlab pipelines HTTP ${res.status}`,permanentDenial:[401,403,404].includes(res.status)?`GitLab pipelines API denied access (HTTP ${res.status}).`:"",checksSource:"" as const };
  const rows = await res.json() as Array<{id?:number;status?:string;ref?:string}>;
  const failed=new Set(["failed","canceled","skipped","manual"]), pending=new Set(["created","waiting_for_resource","preparing","pending","running","scheduled"]);
  const checkFailed=rows.filter(r=>failed.has(r.status??"")).length, checkIncomplete=rows.filter(r=>pending.has(r.status??"")).length, checkPassed=rows.filter(r=>r.status==="success").length;
  const state: import("./github.js").CiState = checkFailed ? "failure" : checkIncomplete ? "pending" : checkPassed && checkPassed===rows.length ? "success" : rows.length ? "unknown" : "none";
  return {state,statusReadable:true,checksReadable:true,statusState:state,statusCount:rows.length,checkTotal:rows.length,checkIncomplete,checkFailed,checkPassed,checkNames:rows.map(r=>`pipeline:${r.id??"unknown"}`),reason:"gitlab pipelines",permanentDenial:"",checksSource:"workflow_runs" as const};
}

export async function getGitLabMergeRequestFiles(input:{repoFullName:string;prNumber:number;token:string;apiBase:string;signal?:AbortSignal}) {
  const res=await fetch(`${input.apiBase}/projects/${project(input.repoFullName)}/merge_requests/${input.prNumber}/changes`,{headers:headers(input.token),signal:input.signal});
  if(!res.ok)throw new Error(`GitLab MR changes failed ${res.status}: ${(await res.text()).slice(0,300)}`);
  const body=await res.json() as {changes?:Array<{new_path?:string;old_path?:string;diff?:string;new_file?:boolean;deleted_file?:boolean;renamed_file?:boolean}>};
  return (body.changes??[]).map(c=>({filename:c.new_path??c.old_path??"",status:c.new_file?"added":c.deleted_file?"removed":c.renamed_file?"renamed":"modified",...(c.diff?{patch:c.diff}:{})})).filter(f=>f.filename);
}

export async function mergeGitLabMergeRequest(input:{repoFullName:string;prNumber:number;token:string;apiBase:string;expectedHeadSha:string;signal?:AbortSignal}) {
  const body=new URLSearchParams({sha:input.expectedHeadSha,squash:"true"});
  const res=await fetch(`${input.apiBase}/projects/${project(input.repoFullName)}/merge_requests/${input.prNumber}/merge`,{method:"PUT",headers:{...headers(input.token),"Content-Type":"application/x-www-form-urlencoded"},body,signal:input.signal});
  const j=await res.json().catch(()=>({})) as {state?:string;merge_commit_sha?:string;squash_commit_sha?:string;message?:string};
  return {merged:res.ok&&j.state==="merged",sha:j.merge_commit_sha??j.squash_commit_sha??"",message:j.message??(!res.ok?`GitLab merge failed ${res.status}`:"")};
}
