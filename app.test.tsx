// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app, { totals } from "./app";
import type { ChangedFile, RepositoryChanges, Snapshot } from "./contracts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
const file = (layer: ChangedFile["layer"]): ChangedFile => ({ path: "Cargo.cs", oldPath: null, layer, status: "MM", additions: 2, deletions: 1, binary: false, notice: null });
const repository: RepositoryChanges = { path: "/workspace/repos/cargo", label: "repos/cargo", branch: "feature", files: [file("staged"), file("unstaged")] };
const snapshot = (): Snapshot => ({ repositories: [repository], errors: [], trackedCount: 1, trackingPending: false });
async function banner(status: () => Snapshot | Promise<Snapshot> = snapshot) {
  const loaded = await loadPluginApp(app);
  expect(loaded.composerCustomizations[0].scopes).toEqual(["thread"]);
  const slot = renderSlot(loaded.composerCustomizations[0].banners![0], {}, { settings: { project: "selected" }, composer: { scope: { kind: "thread", threadId: "one" } }, rpc: { scope: () => ({ enabled: true }), status } });
  cleanup.push(() => slot.lifecycle.unmount());
  return slot;
}
it("does not poll or mount the banner until a project is enabled", async () => {
  const loaded = await loadPluginApp(app);
  const slot = renderSlot(loaded.composerCustomizations[0].banners![0], {}, { composer: { scope: { kind: "thread", threadId: "one" } }, rpc: { status: snapshot } });
  cleanup.push(() => slot.lifecycle.unmount());
  expect(slot.queryByText("Focused Diff")).toBeNull();
  expect(slot.inspection.rpcCalls).toEqual([]);
});
it("does not poll status or diff in a different project, including a restored panel", async () => {
  const loaded = await loadPluginApp(app);
  const options = { settings: { project: "selected" }, composer: { scope: { kind: "thread" as const, threadId: "outside" } }, rpc: { scope: () => ({ enabled: false }) } };
  const bannerSlot = renderSlot(loaded.composerCustomizations[0].banners![0], {}, options);
  const panelSlot = renderSlot(loaded.threadPanelActions[0], { threadId: "outside", params: { repositoryPath: repository.path, label: repository.label, path: "Cargo.cs", layer: "unstaged" } }, options);
  cleanup.push(() => { bannerSlot.lifecycle.unmount(); panelSlot.lifecycle.unmount(); });
  await waitFor(() => expect(panelSlot.inspection.rpcCalls.length).toBe(1));
  expect(bannerSlot.queryByText("Focused Diff")).toBeNull();
  expect(bannerSlot.inspection.rpcCalls.every(call => call.method === "scope")).toBe(true);
  expect(panelSlot.inspection.rpcCalls.every(call => call.method === "scope")).toBe(true);
});
it("counts a staged and unstaged file once, and opens the selected repository's diff", async () => {
  expect(totals([repository])).toEqual({ files: 1, additions: 4, deletions: 2 });
  const slot = await banner();
  await slot.findByText("Focused Diff");
  expect(slot.getByText("1 repo, 1 file")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /Focused Diff/ }));
  expect(slot.getByText("repos/cargo")).toBeTruthy();
  expect(slot.getByText("feature")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open staged diff for repos/cargo/Cargo.cs" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "diff", title: "Cargo.cs", params: { repositoryPath: "/workspace/repos/cargo", label: "repos/cargo", path: "Cargo.cs", layer: "staged" } } });
  expect(slot.inspection.rpcCalls.find(call => call.method === "status")).toMatchObject({ method: "status", input: { threadId: "one" } });
});
it("keeps the banner hidden for a thread that has not modified a repository", async () => {
  const slot = await banner(() => ({ repositories: [], errors: [], trackedCount: 0, trackingPending: false }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "status").length).toBe(1));
  expect(slot.queryByText("Focused Diff")).toBeNull();
});
it("updates the summary on Refresh and shows a request failure instead of silently hiding it", async () => {
  let state = snapshot(), failure = false;
  const slot = await banner(() => { if (failure) throw new Error("Host unavailable"); return state; });
  await slot.findByText("Focused Diff");
  state = { repositories: [], errors: [], trackedCount: 1, trackingPending: false };
  fireEvent.click(slot.getByRole("button", { name: "Refresh focused diff" }));
  await slot.findByText("0 repos, 0 files");
  failure = true;
  fireEvent.click(slot.getByRole("button", { name: "Refresh focused diff" }));
  expect(await slot.findByRole("alert")).toHaveProperty("textContent", "Host unavailable");
});
it("loads the selected file through RPC and switches the native viewer to Split", async () => {
  const loaded = await loadPluginApp(app);
  const slot = renderSlot(loaded.threadPanelActions[0], { threadId: "one", params: { repositoryPath: repository.path, label: repository.label, path: "Cargo.cs", layer: "unstaged" } }, {
    settings: { project: "selected" }, rpc: { scope: () => ({ enabled: true }), diff: () => ({ patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false, notice: null }) },
  });
  cleanup.push(() => slot.lifecycle.unmount());
  await waitFor(() => expect(slot.inspection.rpcCalls.find(call => call.method === "diff")).toMatchObject({ method: "diff", input: { threadId: "one", repositoryPath: repository.path, path: "Cargo.cs", layer: "unstaged" } }));
  const split = slot.getByRole("button", { name: "Split" });
  fireEvent.click(split);
  expect(split.getAttribute("aria-pressed")).toBe("true");
});
