import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, pathSchema, rpcContract, trackingSchema } from "./contracts";
import { changedPaths } from "./tracking";

type Tracking = z.infer<typeof trackingSchema>;
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> & { path: string };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ project: { type: "project", label: "Enabled Project", description: "Show current changes only for threads in this Project." } });
  let enabledProject = (await settings.get()).project;
  settings.onChange(next => { enabledProject = next.project; });
  bb.agents.configure(context => context.project.id === enabledProject
    ? { tools: ["focused_diff_track_repository"], skills: ["focused-diff"] }
    : { tools: [], skills: [] });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const controller = new AbortController();
  const queues = new Map<string, Promise<unknown>>();
  bb.onDispose(() => controller.abort());

  function serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const result = (queues.get(threadId) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(threadId, result);
    void result.finally(() => { if (queues.get(threadId) === result) queues.delete(threadId); }).catch(() => {});
    return result;
  }
  async function environment(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId, signal: controller.signal });
    if (!enabledProject || thread.projectId !== enabledProject) return null;
    if (!thread.environmentId) return null;
    const env = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal: controller.signal });
    return env.path ? { ...env, path: env.path } : null;
  }
  async function tracking(threadId: string): Promise<Tracking> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, signal: controller.signal });
    const parsed = z.object({ tracking: trackingSchema }).safeParse(metadata);
    return parsed.success ? parsed.data.tracking : { cursor: 0, repositories: [] };
  }
  async function save(threadId: string, state: Tracking, announce: boolean) {
    await bb.sdk.threads.updatePluginMetadata({ threadId, signal: controller.signal,
      set: { tracking: { cursor: state.cursor, repositories: state.repositories.map(row => ({ ...row })) } },
    });
    if (announce) bb.realtime.publish("tracked", { threadId });
  }
  function append(state: Tracking, environmentId: string, paths: string[]) {
    for (const path of paths) {
      if (!state.repositories.some(row => row.environmentId === environmentId && row.path === path)) state.repositories.push({ environmentId, path });
    }
    if (state.repositories.length > 128) throw new Error("This thread exceeds the limit of 128 tracked repositories.");
  }
  async function sync(threadId: string, env: Environment, state: Tracking) {
    const initialCursor = state.cursor, initialCount = state.repositories.length;
    let pending = false;
    for (let page = 0; page < 10; page++) {
      const events = await bb.sdk.threads.events.list({ threadId, afterSeq: String(state.cursor), limit: "100", order: "asc", types: ["item/completed"], signal: controller.signal });
      pending = events.length === 100;
      if (!events.length) break;
      const paths = changedPaths(events);
      for (let start = 0; start < paths.length; start += 256) {
        const resolved = await host.call("resolve", { rootPath: env.path, paths: paths.slice(start, start + 256) }, { hostId: env.hostId, signal: controller.signal });
        if (resolved.errors.length) throw new Error(resolved.errors.join("\n"));
        append(state, env.id, resolved.repositories);
      }
      state.cursor = events[events.length - 1].seq;
      if (events.length < 100) break;
    }
    if (state.cursor !== initialCursor) await save(threadId, state, state.repositories.length !== initialCount);
    return { state, pending };
  }
  async function track(threadId: string, path: string) {
    return serial(threadId, async () => {
      const env = await environment(threadId);
      if (!env) throw new Error("Focused Diff is not enabled for this Project, or this thread has no environment.");
      const result = await host.call("resolve", { rootPath: env.path, paths: [path] }, { hostId: env.hostId, signal: controller.signal });
      if (result.errors.length) throw new Error(result.errors.join("\n"));
      if (!result.repositories.length) throw new Error("Path does not identify a Git repository inside this environment.");
      const state = await tracking(threadId);
      append(state, env.id, result.repositories);
      await save(threadId, state, true);
      return { repositories: result.repositories };
    });
  }
  async function status(threadId: string) {
    return serial(threadId, async () => {
      const env = await environment(threadId);
      if (!env) return { repositories: [], errors: [], trackedCount: 0, trackingPending: false };
      const { state, pending } = await sync(threadId, env, await tracking(threadId));
      const repositoryPaths = state.repositories.filter(row => row.environmentId === env.id).map(row => row.path);
      if (!repositoryPaths.length) return { repositories: [], errors: [], trackedCount: 0, trackingPending: pending };
      const snapshot = await host.call("status", { rootPath: env.path, repositoryPaths }, { hostId: env.hostId, signal: controller.signal });
      return { ...snapshot, trackedCount: repositoryPaths.length, trackingPending: pending };
    });
  }
  bb.rpc.register(rpcContract, {
    scope: async ({ threadId }) => ({ enabled: !!enabledProject && (await bb.sdk.threads.get({ threadId, signal: controller.signal })).projectId === enabledProject }),
    status: ({ threadId }) => status(threadId),
    diff: async ({ threadId, repositoryPath, path, layer }) => {
      const env = await environment(threadId);
      if (!env) throw new Error("Focused Diff is not enabled for this Project, or this thread has no environment.");
      const state = await tracking(threadId);
      if (!state.repositories.some(row => row.environmentId === env.id && row.path === repositoryPath)) throw new Error("Repository is not tracked by this thread.");
      return host.call("diff", { rootPath: env.path, repositoryPath, path, layer }, { hostId: env.hostId, signal: controller.signal });
    },
  });
  bb.events.on("experimental_thread.events", ({ thread }) => serial(thread.id, async () => {
    if (!enabledProject || thread.projectId !== enabledProject) return;
    const env = await environment(thread.id);
    if (env) await sync(thread.id, env, await tracking(thread.id));
  }).catch(cause => {
    if (!controller.signal.aborted) bb.log.warn(`Could not update tracked repositories for ${thread.id}: ${String(cause)}`);
  }));
  bb.agents.registerTool({
    name: "focused_diff_track_repository",
    description: "Register a repository this thread will modify, so its current diff appears above the composer.",
    instructions: "Before modifying or committing files in a Git repository, call focused_diff_track_repository once with its absolute path. Register only repositories you modify, not ones you merely read or temporary test fixtures. FileChange events are also tracked automatically, but shell changes require this registration. In an existing session without this tool, run bb focused-diff track --path /absolute/repository/path.",
    presentation: { suppress: true },
    parameters: z.object({ path: pathSchema }).strict(),
    execute: async ({ path }, context) => JSON.stringify(await track(context.threadId, path)),
  });
  const threadOption = { type: "string" as const, description: "Thread ID; defaults to the invoking thread." };
  function threadId(value: string | undefined, current: string | undefined) {
    if (value ?? current) return (value ?? current)!;
    throw new PluginCliError("A thread is required.", { code: "thread_required", hint: "Pass --thread <thread-id>." });
  }
  bb.cli.register(defineCli({ name: "focused-diff", summary: "Track repositories modified by the current thread and inspect their changes.", commands: {
    track: cliCommand({ summary: "Register a repository before modifying it.",
      options: { thread: threadOption, path: { type: "string", required: true, description: "Absolute repository or file path on the thread's machine." }, json: { type: "boolean", description: "Print JSON." } },
      run: async (input, ctx) => ({ exitCode: 0, stdout: JSON.stringify(await track(threadId(input.options.thread, ctx.threadId), input.options.path)) }),
    }),
    status: cliCommand({ summary: "Show current changes in this thread's tracked repositories.",
      options: { thread: threadOption, json: { type: "boolean", description: "Print JSON." } },
      run: async (input, ctx) => ({ exitCode: 0, stdout: JSON.stringify(await status(threadId(input.options.thread, ctx.threadId))) }),
    }),
  } }));
}
