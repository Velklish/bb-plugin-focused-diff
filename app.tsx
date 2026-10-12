import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_Diff as Diff, useBbNavigate, useComposer, useRealtime, useRpc, useSettings, useBbContext } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { FileDiff, RepositoryChanges, Snapshot, rpcContract } from "./contracts";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";

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
  return <span className="flex shrink-0 gap-2 tabular-nums">
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
  return scope.error ? <p role="alert" className="p-4 text-sm text-destructive">{scope.error}</p> : scope.enabled ? <EnabledChangesBanner /> : null;
}
function EnabledChangesBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("status", { threadId }), [rpc, threadId]);
  const { data, error, refetch } = usePolling<Snapshot>(load);
  const [expanded, setExpanded] = useState(false);
  const repositories = data?.repositories ?? [], tally = totals(repositories);
  if (tally.files === 0 && !data?.trackingPending && !error && !data?.errors.length) return null;
  return <div>
    <div className="flex min-h-10 items-center gap-1 px-2">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-expanded={expanded} aria-controls={`focused-diff-${threadId}`} onClick={() => setExpanded(value => !value)}>
        <Icon name="Code" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">Focused Diff</span>
        <span className="hidden shrink-0 text-muted-foreground sm:inline">{repositories.length} repo{repositories.length === 1 ? "" : "s"}, {tally.files} file{tally.files === 1 ? "" : "s"}</span>
        <Tally {...tally} />
        {repositories.some(repo => repo.files.some(file => file.notice && !file.binary)) ? <span className="text-xs text-muted-foreground">partial</span> : null}
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </button>
      <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Refresh focused diff" onClick={refetch}><Icon name="RotateCcw" /></Button>
    </div>
    {error ? <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p> : null}
    {data?.trackingPending ? <p role="status" className="px-4 pb-2 text-sm text-muted-foreground">Reading the remaining thread history…</p> : null}
    {data?.errors.map((message, index) => <p key={index} role="alert" className="px-4 pb-2 text-sm text-destructive">{message}</p>)}
    {expanded ? <div id={`focused-diff-${threadId}`} className="max-h-80 overflow-y-auto border-t border-border px-2 py-2">
      {repositories.length === 0 ? <p className="px-2 py-2 text-sm text-muted-foreground">No uncommitted changes in this thread's tracked repositories.</p> : null}
      {repositories.map(repository => <section key={repository.path} className="mb-2 last:mb-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-xs text-muted-foreground">
          <span className="break-all font-medium text-foreground">{repository.label}</span><span>{repository.branch}</span>
        </div>
        {repository.files.map(file => <button type="button" key={`${file.layer}:${file.path}`} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={`Open ${file.layer} diff for ${repository.label}/${file.path}`} onClick={() => {
          navigate.openThreadPanel({ actionId: "diff", title: file.path, params: { repositoryPath: repository.path, label: repository.label, path: file.path, layer: file.layer } });
        }}>
          <span className="w-16 shrink-0 text-xs text-muted-foreground">{file.layer}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{file.status.trim()}</span>
          <span className="min-w-0 flex-1 break-all">{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span>
          {file.notice || file.binary ? <span className="shrink-0 text-xs text-muted-foreground">{file.binary ? "Binary" : "Large file"}</span> : <Tally additions={file.additions} deletions={file.deletions} />}
        </button>)}
      </section>)}
    </div> : null}
  </div>;
}
const selectionSchema = z.object({ repositoryPath: z.string().min(1).max(4096), label: z.string(), path: z.string().min(1).max(4096), layer: z.enum(["staged", "unstaged", "untracked"]) });
function DiffBody({ threadId, selection }: { threadId: string; selection: z.infer<typeof selectionSchema> }) {
  const rpc = useRpc<typeof rpcContract>();
  const { repositoryPath, path, layer } = selection;
  const load = useCallback(() => rpc.call("diff", { threadId, repositoryPath, path, layer }), [rpc, threadId, repositoryPath, path, layer]);
  const { data, error, refetch } = usePolling<FileDiff>(load);
  const [view, setView] = useState<"unified" | "split">("unified");
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-sm">
      <div className="min-w-0 flex-1 break-all"><span className="font-medium">{path}</span><p className="text-xs text-muted-foreground">{selection.label} / {layer}</p></div>
      <Button variant="ghost" size="sm" aria-pressed={view === "unified"} onClick={() => setView("unified")}>Unified</Button>
      <Button variant="ghost" size="sm" aria-pressed={view === "split"} onClick={() => setView("split")}>Split</Button>
      <Button variant="ghost" size="icon" aria-label="Refresh diff" onClick={refetch}><Icon name="RotateCcw" /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
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
  app.composer.customize({ id: "focused-diff", scopes: ["thread"], banners: [{ id: "changes", component: ChangesBanner }] });
  app.slots.threadPanelAction({ id: "diff", title: "Focused Diff", icon: "Code", layout: "flush", component: DiffPanel });
});
