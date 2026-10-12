import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function fileEvent(seq: number, path: string, status = "completed") {
  return { seq, type: "item/completed", data: { item: { type: "fileChange", status, changes: [{ path }] } } };
}
async function setup(events: Record<string, ReturnType<typeof fileEvent>[]> = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  const calls: { method: string; hostId: string; input: unknown }[] = [];
  const host = createFakePluginHost({ pluginId: "focused-diff", sdk: {
    environments: { get: async () => ({ id: "env", hostId: "host", path: "/workspace" }) },
    threads: {
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: threadId === "outside" ? "outside" : "selected", environmentId: "env" }),
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      updatePluginMetadata: async ({ threadId, set }) => {
        const value = { ...metadata.get(threadId), ...set }; metadata.set(threadId, value); return value;
      },
      events: { list: async ({ threadId, afterSeq, limit }) => (events[threadId] ?? []).filter(event => event.seq > Number(afterSeq)).slice(0, Number(limit)) },
    },
  }, settings: { project: "selected" }, agentSkillIds: ["focused-diff"], experimental_callHostRpc: async call => {
    calls.push({ method: call.method, hostId: call.hostId, input: call.input });
    if (call.method === "resolve") {
      const { paths } = call.input as { paths: string[] };
      return { repositories: [...new Set(paths.map(path => path.split("/").slice(0, 4).join("/")))], errors: [] };
    }
    if (call.method === "status") return { repositories: [], errors: [] };
    return { patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false, notice: null };
  } });
  await plugin(host.bb); disposals.push(() => host.harness.lifecycle.dispose());
  return { ...host, metadata, calls };
}
describe("repositories modified by the current thread", () => {
  it("does not track, inspect Git, or write metadata outside the selected project", async () => {
    const { harness, calls, metadata } = await setup({ outside: [fileEvent(1, "/workspace/repos/cargo/a.cs")] });
    expect(await harness.behavior.callRpc("status", { threadId: "outside" })).toEqual({ repositories: [], errors: [], trackedCount: 0, trackingPending: false });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "outside", projectId: "outside", environmentId: "env" }), sequence: 1 });
    await expect(harness.behavior.callAgentTool("focused_diff_track_repository", { path: "/workspace/repos/cargo" }, { threadId: "outside" })).rejects.toThrow("not enabled");
    expect(calls).toEqual([]); expect(metadata.size).toBe(0);
  });
  it("selects tools and skills only for the enabled project and stops tracking when disabled", async () => {
    const { harness, calls, metadata } = await setup({ one: [fileEvent(1, "/workspace/repos/cargo/a.cs")] });
    const selected = makePluginAgentConfigurationContext({ project: { id: "selected" } });
    const outside = makePluginAgentConfigurationContext({ project: { id: "outside" } });
    expect(await harness.resolveAgentConfiguration(selected)).toMatchObject({ tools: [expect.objectContaining({ name: "focused_diff_track_repository" })], skills: ["focused-diff"] });
    expect(await harness.resolveAgentConfiguration(outside)).toMatchObject({ tools: [], skills: [] });
    await harness.behavior.setSettings({ project: null });
    expect(await harness.resolveAgentConfiguration(selected)).toMatchObject({ tools: [], skills: [] });
    await harness.behavior.callRpc("status", { threadId: "one" });
    expect(calls).toEqual([]); expect(metadata.size).toBe(0);
  });
  it("backfills successful file changes and keeps another thread's repositories out", async () => {
    const { harness, calls, metadata } = await setup({ one: [fileEvent(1, "/workspace/repos/cargo/a.cs"), fileEvent(2, "/workspace/repos/unrelated/a.cs", "failed")], two: [fileEvent(3, "/workspace/repos/other/a.cs")] });
    expect(await harness.behavior.callRpc("status", { threadId: "one" })).toMatchObject({ trackedCount: 1 });
    expect(calls.find(call => call.method === "status")).toEqual({ method: "status", hostId: "host", input: { rootPath: "/workspace", repositoryPaths: ["/workspace/repos/cargo"] } });
    expect(metadata.has("two")).toBe(false);
    await harness.behavior.callRpc("status", { threadId: "one" });
    expect(calls.filter(call => call.method === "resolve")).toHaveLength(1);
  });
  it("does not inspect Git repositories for a thread with no recorded work", async () => {
    const { harness, calls } = await setup();
    expect(await harness.behavior.callRpc("status", { threadId: "empty" })).toEqual({ repositories: [], errors: [], trackedCount: 0, trackingPending: false });
    expect(calls).toEqual([]);
  });
  it("serializes concurrent explicit registrations without losing either repository", async () => {
    const { harness, metadata } = await setup();
    await Promise.all([
      harness.behavior.runCli(["track", "--path", "/workspace/repos/first"], { threadId: "one" }),
      harness.behavior.runCli(["track", "--path", "/workspace/repos/second"], { threadId: "one" }),
    ]);
    expect(metadata.get("one")).toEqual({ tracking: { cursor: 0, repositories: [{ environmentId: "env", path: "/workspace/repos/first" }, { environmentId: "env", path: "/workspace/repos/second" }] } });
  });
  it("rejects a diff for a repository absent from this thread", async () => {
    const { harness, calls } = await setup();
    await expect(harness.behavior.callRpc("diff", { threadId: "one", repositoryPath: "/workspace/repos/other", path: "a.cs", layer: "unstaged" })).rejects.toThrow("not tracked");
    expect(calls).toEqual([]);
  });
  it("tracks shell work through the agent tool and routes the diff to the environment host", async () => {
    const { harness, metadata, calls } = await setup();
    await harness.behavior.callAgentTool("focused_diff_track_repository", { path: "/workspace/repos/cargo" }, { threadId: "one" });
    expect(metadata.has("one")).toBe(true);
    await harness.behavior.callRpc("diff", { threadId: "one", repositoryPath: "/workspace/repos/cargo", path: "a.cs", layer: "staged" });
    expect(calls.at(-1)).toEqual({ method: "diff", hostId: "host", input: { rootPath: "/workspace", repositoryPath: "/workspace/repos/cargo", path: "a.cs", layer: "staged" } });
  });
  it("observes completed file changes without an open frontend", async () => {
    const { harness, metadata } = await setup({ one: [fileEvent(1, "/workspace/repos/cargo/a.cs")] });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "one", projectId: "selected", environmentId: "env" }), sequence: 1 });
    expect(metadata.get("one")).toMatchObject({ tracking: { cursor: 1, repositories: [{ path: "/workspace/repos/cargo" }] } });
  });
  it("pages through event history and ignores malformed metadata", async () => {
    const events = Array.from({ length: 103 }, (_, index) => fileEvent(index + 1, "/workspace/repos/cargo/a.cs"));
    const { harness, metadata } = await setup({ one: events });
    metadata.set("one", { unrelated: "keep", tracking: { repositories: "invalid" } });
    await harness.behavior.callRpc("status", { threadId: "one" });
    expect(metadata.get("one")).toMatchObject({ unrelated: "keep", tracking: { cursor: 103, repositories: [{ path: "/workspace/repos/cargo" }] } });
  });
});
it("uses only public SDK surfaces", () => {
  const scan = experimental_scanPublicSdkOnly(import.meta.dirname, { allow: ["react", "react-dom", "@testing-library/react", "@radix-ui/react-slot", "class-variance-authority", "clsx", "tailwind-merge"].map(name => new RegExp(`^${name}$`)) });
  expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
});
