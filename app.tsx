import { useCallback, useEffect, useId, useRef, useState } from "react";
import { definePluginApp, experimental_Diff as Diff, experimental_usePluginId, useBbNavigate, useComposer, useRealtime, useRpc, useSettings, useBbContext } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { ChangedFile, FileDiff, RepositoryChanges, Snapshot, rpcContract } from "./contracts";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { mountNativeTracker } from "./native-tracker";

function usePolling<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false, busy = false, pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);
    const update = async () => {
      if (busy) { pending = true; return; }
      if (timer) clearTimeout(timer);
      busy = true;
      try {
        const result = await load();
        if (!disposed) { setData(result); setError(null); }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busy = false;
        if (!disposed) {
          if (pending) { pending = false; void update(); }
          else timer = setTimeout(tick, 5000);
        }
      }
    };
    const tick = () => {
      if (document.hidden) timer = setTimeout(tick, 5000);
      else void update();
    };
    const visible = () => { if (!document.hidden) void update(); };
    refresh.current = () => { void update(); };
    document.addEventListener("visibilitychange", visible);
    void update();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); refresh.current = () => {}; };
  }, [load]);
  const refetch = useCallback(() => refresh.current(), []);
  useRealtime("tracked", refetch);
  return { data, error, refetch };
}
export function totals(repositories: RepositoryChanges[]) {
  let files = 0, additions = 0, deletions = 0;
  for (const repository of repositories) {
    files += new Set(repository.files.map(file => file.path)).size;
    for (const file of repository.files) { additions += file.additions; deletions += file.deletions; }
  }
  return { files, additions, deletions };
}
function Tally({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="flex shrink-0 gap-1 whitespace-nowrap tabular-nums">
    <span className="text-diff-added">+{additions.toLocaleString()}</span>
    <span className="text-diff-removed">−{deletions.toLocaleString()}</span>
  </span>;
}
function useEnabledProject(threadId: string) {
  const { values } = useSettings();
  const context = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const key = JSON.stringify([threadId, values?.project, context.projectId]);
  const [result, setResult] = useState<{ key: string; enabled: boolean; error: string | null } | null>(null);
  useEffect(() => {
    if (!values?.project) return;
    let disposed = false;
    void rpc.call("scope", { threadId }).then(scope => {
      if (!disposed) setResult({ key, enabled: scope.enabled, error: null });
    }, cause => { if (!disposed) setResult({ key, enabled: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { disposed = true; };
  }, [rpc, threadId, key, values?.project]);
  return result?.key === key && values?.project ? result : { enabled: false, error: null };
}
function ChangesBanner() {
  const composer = useComposer();
  const scope = useEnabledProject(composer.scope.kind === "thread" ? composer.scope.threadId : "");
  return scope.error ? <p role="alert" className="p-4 text-sm text-destructive">{scope.error}</p> : scope.enabled ? <EnabledChangesBanner key={composer.scope.kind === "thread" ? composer.scope.threadId : ""} /> : null;
}
function ChangeSection({ repository, files, layer }: { repository: RepositoryChanges; files: ChangedFile[]; layer: "uncommitted" | "committed" }) {
  const [expanded, setExpanded] = useState(true);
  const navigate = useBbNavigate();
  const id = useId();
  if (!files.length) return null;
  const tally = totals([{ ...repository, files }]), title = layer === "committed" ? "Committed" : "Uncommitted";
  return <section className="min-w-0">
    <button type="button" className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <Icon name="FileDiff" className="size-3.5 shrink-0 text-muted-foreground" /><span>{title}</span>
      <span className="shrink-0 text-muted-foreground">· {tally.files} file{tally.files === 1 ? "" : "s"},</span><Tally {...tally} />
      {layer === "committed" && repository.baseBranch ? <span className="min-w-0 truncate text-muted-foreground" title={`Compared with ${repository.baseBranch}`}>vs {repository.baseBranch}</span> : null}
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="ml-auto size-3 shrink-0 text-muted-foreground" />
    </button>
    <div id={id} hidden={!expanded} className="max-h-32 overflow-y-auto py-0.5">
      {files.map(file => <button type="button" key={file.path} className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded px-2 py-0.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} aria-label={`Open ${title} diff for ${repository.label}/${file.path}`} onClick={() => {
        navigate.openThreadPanel({ actionId: "diff", title: file.path, params: { repositoryPath: repository.path, label: repository.label, path: file.path, layer, ...(layer === "committed" && repository.baseBranch ? { baseBranch: repository.baseBranch } : {}) } });
      }}>
        <span className="w-4 shrink-0 text-center text-muted-foreground">{file.status === "??" ? "A?" : file.status.trim()}</span>
        <span className="min-w-0 flex-1 truncate">{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span>
        {file.notice || file.binary ? <span className="shrink-0 text-muted-foreground" title={file.notice || undefined}>{file.status === "U" ? "Conflict" : file.binary ? "Binary" : "Large file"}</span> : <Tally additions={file.additions} deletions={file.deletions} />}
      </button>)}
    </div>
  </section>;
}
function RepositoryGroup({ repository, threadId }: { repository: RepositoryChanges; threadId: string }) {
  const pluginId = experimental_usePluginId();
  const storageKey = JSON.stringify([pluginId, "repository-expanded", threadId, repository.path]);
  const [expanded, setExpanded] = useState(() => {
    try { return window.localStorage.getItem(storageKey) !== "false"; } catch { return true; }
  });
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try { window.localStorage.setItem(storageKey, String(next)); } catch { /* Keep disclosure usable when browser storage is unavailable. */ }
  };
  const tally = totals([repository]);
  const id = useId();
  const name = repository.path.split(/[\\/]/).filter(Boolean).at(-1) || repository.label;
  return <section className="min-w-0 border-t border-border">
    <button type="button" className="flex min-h-9 w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" title={repository.path} aria-expanded={expanded} aria-controls={id} aria-label={`${expanded ? "Collapse" : "Expand"} repository ${repository.label}`} onClick={toggle}>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 text-muted-foreground" /><Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{name}</span><span className="hidden min-w-0 items-center gap-1 truncate text-muted-foreground sm:flex"><Icon name="GitBranch" className="size-3 shrink-0" /><span className="truncate">{repository.branch}</span></span>
      <span className="ml-auto shrink-0 text-muted-foreground">{tally.files} file{tally.files === 1 ? "" : "s"}</span><Tally {...tally} />
    </button>
    <div id={id} hidden={!expanded} className="min-w-0 space-y-1 pb-2 pl-5 pr-2">
      <ChangeSection repository={repository} files={repository.files.filter(file => file.layer !== "committed")} layer="uncommitted" />
      <ChangeSection repository={repository} files={repository.files.filter(file => file.layer === "committed")} layer="committed" />
      {repository.comparisonError ? <p role="alert" className="px-2 py-1 text-xs text-destructive">{repository.comparisonError}</p> : null}
    </div>
  </section>;
}
function EnabledChangesBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("status", { threadId }), [rpc, threadId]);
  const { data, error, refetch } = usePolling<Snapshot>(load);
  const [expanded, setExpanded] = useState(false);
  const repositories = data?.repositories ?? [], tally = totals(repositories);
  if (tally.files === 0 && !repositories.some(repo => repo.comparisonError) && !data?.trackingPending && !error && !data?.errors.length) return null;
  return <div data-focused-diff-replacement={data && !error && !data.errors.length ? "" : undefined} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-raised-solid">
    <div className="flex min-h-9 items-center gap-1 pr-1">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-expanded={expanded} aria-controls={`focused-diff-${threadId}`} onClick={() => setExpanded(value => !value)}>
        <Icon name="FileDiff" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">Changes</span>
        <span className="min-w-0 truncate text-muted-foreground">· {repositories.length} repo{repositories.length === 1 ? "" : "s"}, {tally.files} file{tally.files === 1 ? "" : "s"},</span>
        <Tally {...tally} />
        {repositories.some(repo => repo.files.some(file => file.notice && !file.binary)) ? <span className="text-xs text-muted-foreground">partial</span> : null}
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label="Refresh changes" onClick={refetch}><Icon name="RotateCcw" className="size-3.5" /></Button>
    </div>
    {error ? <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p> : null}
    {data?.trackingPending ? <p role="status" className="px-4 pb-2 text-sm text-muted-foreground">Reading the remaining thread history…</p> : null}
    {data?.errors.map((message, index) => <p key={index} role="alert" className="px-4 pb-2 text-sm text-destructive">{message}</p>)}
    <div id={`focused-diff-${threadId}`} hidden={!expanded} className="max-h-96 overflow-y-auto">
      {repositories.length === 0 ? <p className="px-2 py-2 text-sm text-muted-foreground">No uncommitted changes in this thread's tracked repositories.</p> : null}
      {repositories.map(repository => <RepositoryGroup key={repository.path} repository={repository} threadId={threadId} />)}
    </div>
  </div>;
}
const selectionSchema = z.object({ repositoryPath: z.string().min(1).max(4096), label: z.string(), path: z.string().min(1).max(4096), layer: z.enum(["uncommitted", "committed", "staged", "unstaged", "untracked"]), baseBranch: z.string().min(1).max(1024).optional() });
function DiffBody({ threadId, selection }: { threadId: string; selection: z.infer<typeof selectionSchema> }) {
  const rpc = useRpc<typeof rpcContract>();
  const { repositoryPath, path, layer, baseBranch } = selection;
  const load = useCallback(() => rpc.call("diff", { threadId, repositoryPath, path, layer, ...(baseBranch ? { baseBranch } : {}) }), [rpc, threadId, repositoryPath, path, layer, baseBranch]);
  const { data, error, refetch } = usePolling<FileDiff>(load);
  const [view, setView] = useState<"unified" | "split">("unified");
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-sm">
      <div className="min-w-0 flex-1 break-all"><span className="font-medium">{path}</span><p className="text-xs text-muted-foreground">{selection.label} / {layer === "committed" ? "Committed" : layer === "uncommitted" ? "Uncommitted" : layer}{baseBranch ? ` vs ${baseBranch}` : ""}</p></div>
      <Button variant="ghost" size="sm" aria-pressed={view === "unified"} onClick={() => setView("unified")}>Unified</Button>
      <Button variant="ghost" size="sm" aria-pressed={view === "split"} onClick={() => setView("split")}>Split</Button>
      <Button variant="ghost" size="icon" aria-label="Refresh diff" onClick={refetch}><Icon name="RotateCcw" /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      {data?.patch && data.notice ? <p role="status" className="px-4 py-2 text-sm text-destructive">{data.notice}</p> : null}
      {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : data === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading diff…</p> : data.patch ? <Diff patch={data.patch} path={path} view={view} /> : <p role="status" className="p-4 text-sm text-muted-foreground">{data.notice}</p>}
    </div>
  </div>;
}
function DiffPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const scope = useEnabledProject(threadId);
  const selection = selectionSchema.safeParse(params);
  if (scope.error) return <p role="alert" className="p-4 text-sm text-destructive">{scope.error}</p>;
  if (!scope.enabled) return <p role="status" className="p-4 text-sm text-muted-foreground">Focused Diff is inactive for this Project.</p>;
  return selection.success ? <DiffBody threadId={threadId} selection={selection.data} /> : <p role="alert" className="p-4 text-sm text-destructive">Select a changed file above the composer.</p>;
}
export default definePluginApp(app => {
  app.contentScripts.register({ id: "native-tracker", mount: mountNativeTracker });
  app.composer.customize({ id: "focused-diff", scopes: ["thread"], banners: [{ id: "changes", chrome: "bare", component: ChangesBanner }] });
  app.slots.threadPanelAction({ id: "diff", title: "Focused Diff", icon: "Code", layout: "flush", component: DiffPanel });
});
