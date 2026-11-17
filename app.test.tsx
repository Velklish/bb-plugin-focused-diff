// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app, { totals } from "./app";
import type { ChangedFile, RepositoryChanges, Snapshot } from "./contracts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
});
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.unstubAllGlobals(); });
const file = (layer: ChangedFile["layer"]): ChangedFile => ({ path: "Cargo.cs", oldPath: null, layer, status: "M", additions: 2, deletions: 1, binary: false, notice: null });
const repository: RepositoryChanges = { path: "/workspace/repos/cargo", label: "repos/cargo", branch: "feature", files: [file("uncommitted"), file("committed")], baseBranch: "origin/main", comparisonError: null };
const snapshot = (): Snapshot => ({ repositories: [repository], errors: [], trackedCount: 1, trackingPending: false });
async function banner(status: () => Snapshot | Promise<Snapshot> = snapshot, threadId = "one", pluginId = "focused-diff") {
  const loaded = await loadPluginApp(app);
  expect(loaded.composerCustomizations[0].scopes).toEqual(["thread"]);
  const slot = renderSlot(loaded.composerCustomizations[0].banners![0], {}, { pluginId, settings: { project: "selected" }, composer: { scope: { kind: "thread", threadId } }, rpc: { scope: () => ({ enabled: true }), status } });
  cleanup.push(() => slot.lifecycle.unmount());
  return slot;
}
it("does not poll or mount the banner until a project is enabled", async () => {
  const loaded = await loadPluginApp(app);
  const slot = renderSlot(loaded.composerCustomizations[0].banners![0], {}, { composer: { scope: { kind: "thread", threadId: "one" } }, rpc: { status: snapshot } });
  cleanup.push(() => slot.lifecycle.unmount());
  expect(slot.queryByText("Changes")).toBeNull();
  expect(slot.inspection.rpcCalls).toEqual([]);
});
it("does not poll status or diff in a different project, including a restored panel", async () => {
  const loaded = await loadPluginApp(app);
  const options = { settings: { project: "selected" }, composer: { scope: { kind: "thread" as const, threadId: "outside" } }, rpc: { scope: () => ({ enabled: false }) } };
  const bannerSlot = renderSlot(loaded.composerCustomizations[0].banners![0], {}, options);
  const panelSlot = renderSlot(loaded.threadPanelActions[0], { threadId: "outside", params: { repositoryPath: repository.path, label: repository.label, path: "Cargo.cs", layer: "unstaged" } }, options);
  cleanup.push(() => { bannerSlot.lifecycle.unmount(); panelSlot.lifecycle.unmount(); });
  await waitFor(() => expect(panelSlot.inspection.rpcCalls.length).toBe(1));
  expect(bannerSlot.queryByText("Changes")).toBeNull();
  expect(bannerSlot.inspection.rpcCalls.every(call => call.method === "scope")).toBe(true);
  expect(panelSlot.inspection.rpcCalls.every(call => call.method === "scope")).toBe(true);
});
it("counts one path across sections once and opens both kinds of diff in the selected repository", async () => {
  expect(totals([repository])).toEqual({ files: 1, additions: 4, deletions: 2 });
  const slot = await banner();
  await slot.findByText("Changes");
  expect(slot.getByText("· 1 repo, 1 file,")).toBeTruthy();
  const summary = slot.getByRole("button", { name: /^Changes/ });
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: "Collapse repository repos/cargo" })).toBeNull();
  fireEvent.click(summary);
  expect(slot.getByText("cargo")).toBeTruthy();
  expect(slot.getByText("feature")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open Uncommitted diff for repos/cargo/Cargo.cs" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "diff", title: "Cargo.cs", params: { repositoryPath: "/workspace/repos/cargo", label: "repos/cargo", path: "Cargo.cs", layer: "uncommitted" } } });
  fireEvent.click(slot.getByRole("button", { name: "Open Committed diff for repos/cargo/Cargo.cs" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "diff", title: "Cargo.cs", params: { repositoryPath: repository.path, label: repository.label, path: "Cargo.cs", layer: "committed", baseBranch: "origin/main" } } });
  expect(slot.inspection.rpcCalls.find(call => call.method === "status")).toMatchObject({ method: "status", input: { threadId: "one" } });
});
it.each([0, 2])("keeps the banner hidden without changes, with %i tracked repositories", async trackedCount => {
  const slot = await banner(() => ({ repositories: [], errors: [], trackedCount, trackingPending: false }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "status").length).toBe(1));
  await act(async () => {});
  expect(slot.queryByText("Changes")).toBeNull();
});
it("hides a clean summary on Refresh, reappears on changes, and shows request failures", async () => {
  let state = snapshot(), failure = false;
  const slot = await banner(() => { if (failure) throw new Error("Host unavailable"); return state; });
  await slot.findByText("Changes");
  state = { repositories: [], errors: [], trackedCount: 1, trackingPending: false };
  fireEvent.click(slot.getByRole("button", { name: "Refresh changes" }));
  await waitFor(() => expect(slot.queryByText("Changes")).toBeNull());
  state = snapshot();
  await slot.behavior.emitRealtime("tracked", { threadId: "one" });
  await slot.findByText("Changes");
  failure = true;
  fireEvent.click(slot.getByRole("button", { name: "Refresh changes" }));
  expect(await slot.findByRole("alert")).toHaveProperty("textContent", "Host unavailable");
});
it("keeps zero-line file changes, Git errors, and pending history visible", async () => {
  const binary = await banner(() => ({ ...snapshot(), repositories: [{ ...repository, files: [{ ...file("unstaged"), binary: true, additions: 0, deletions: 0 }] }] }));
  await binary.findByText("Changes");
  expect(binary.getByText("· 1 repo, 1 file,")).toBeTruthy();
  const pending = await banner(() => ({ repositories: [], errors: ["Git unavailable"], trackedCount: 1, trackingPending: true }));
  expect(await pending.findByRole("alert")).toHaveProperty("textContent", "Git unavailable");
  expect(pending.getByRole("status")).toHaveProperty("textContent", "Reading the remaining thread history…");
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
it("collapses repositories independently and retains section state through outer collapse", async () => {
  const second = { ...repository, path: "/workspace/other", label: "other" };
  const slot = await banner(() => ({ ...snapshot(), repositories: [repository, second] }));
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getByRole("button", { name: "Collapse repository repos/cargo" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Collapse repository other" })).toBeTruthy();
  const committed = slot.getAllByRole("button", { name: /^Committed/ })[0];
  fireEvent.click(committed);
  fireEvent.click(slot.getByRole("button", { name: "Collapse repository repos/cargo" }));
  expect(slot.queryByRole("button", { name: "Open Uncommitted diff for repos/cargo/Cargo.cs" })).toBeNull();
  expect(slot.getByRole("button", { name: "Open Uncommitted diff for other/Cargo.cs" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  fireEvent.click(slot.getByRole("button", { name: "Expand repository repos/cargo" }));
  expect(committed.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: "Open Committed diff for repos/cargo/Cargo.cs" })).toBeNull();
});
it("groups linked checkouts, keeps a separate clone, and opens each checkout's diff", async () => {
  const main = { ...repository, commonDir: "/workspace/repos/cargo/.git", branch: "main" };
  const worker = { ...main, path: "/workspace/sandbox/worker", label: "sandbox/worker", branch: "feature", baseBranch: "main" };
  const clone = { ...main, path: "/workspace/clones/cargo", label: "clones/cargo", commonDir: "/workspace/clones/cargo/.git", branch: "release" };
  const slot = await banner(() => ({ ...snapshot(), repositories: [clone, main, worker] }));
  await slot.findByText("Changes");
  expect(slot.getByText("· 2 repos, 3 files,")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getAllByRole("button", { name: /^Collapse repository/ })).toHaveLength(2);
  expect(slot.getByText("worker")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open Committed diff for sandbox/worker/Cargo.cs" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "diff", title: "Cargo.cs", params: { repositoryPath: worker.path, label: worker.label, path: "Cargo.cs", layer: "committed", baseBranch: "main" } } });
});
it("collapses a checkout independently and restores its disclosure after remount", async () => {
  const main = { ...repository, commonDir: "/workspace/repos/cargo/.git", branch: "main" };
  const worker = { ...main, path: "/workspace/sandbox/worker", label: "sandbox/worker", branch: "worker" };
  const status = () => ({ ...snapshot(), repositories: [main, worker] });
  const slot = await banner(status);
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getAllByText("cargo")).toHaveLength(1);
  expect(slot.getAllByText("worker")).toHaveLength(1);

  fireEvent.click(slot.getAllByRole("button", { name: /^Committed/ })[1]);
  fireEvent.click(slot.getByRole("button", { name: "Collapse checkout sandbox/worker" }));
  const collapsed = slot.getByRole("button", { name: "Expand checkout sandbox/worker" });
  expect(collapsed.textContent).toContain("1 file");
  expect(slot.queryByRole("button", { name: "Open Uncommitted diff for sandbox/worker/Cargo.cs" })).toBeNull();
  expect(slot.getByRole("button", { name: "Open Uncommitted diff for repos/cargo/Cargo.cs" })).toBeTruthy();
  fireEvent.click(collapsed);
  expect(slot.queryByRole("button", { name: "Open Committed diff for sandbox/worker/Cargo.cs" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Collapse checkout sandbox/worker" }));
  slot.lifecycle.unmount();

  const reloaded = await banner(status);
  await reloaded.findByText("Changes");
  fireEvent.click(reloaded.getByRole("button", { name: /^Changes/ }));
  expect(reloaded.getByRole("button", { name: "Expand checkout sandbox/worker" })).toBeTruthy();
  expect(reloaded.getByRole("button", { name: "Collapse checkout repos/cargo" })).toBeTruthy();
});
it("shows the repository name and the checkout branch when only a linked checkout has changes", async () => {
  const worker = { ...repository, path: "/workspace/sandbox/worker", label: "sandbox/worker", commonDir: "/workspace/repos/cargo/.git" };
  const slot = await banner(() => ({ ...snapshot(), repositories: [worker] }));
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getByText("cargo")).toBeTruthy();
  expect(slot.getByText("feature")).toBeTruthy();
  expect(slot.queryByText("worker")).toBeNull();
  expect(slot.getByRole("button", { name: "Open Uncommitted diff for sandbox/worker/Cargo.cs" })).toBeTruthy();
});
it.each([repository.path, "/workspace/sandbox/worker"])("retains the old checkout disclosure preference from %s", async path => {
  window.localStorage.setItem(JSON.stringify(["focused-diff", "repository-expanded", "one", path]), "false");
  const worker = { ...repository, path: "/workspace/sandbox/worker", label: "sandbox/worker", commonDir: "/workspace/repos/cargo/.git" };
  const slot = await banner(() => ({ ...snapshot(), repositories: [worker] }));
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getByRole("button", { name: "Expand repository cargo" })).toBeTruthy();
});
it("withdraws the replacement marker on a failed refresh so native Git remains available", async () => {
  let failure = false;
  const slot = await banner(() => { if (failure) throw new Error("Offline"); return snapshot(); });
  await slot.findByText("Changes");
  const card = slot.getByText("Changes").closest("[data-focused-diff-replacement]");
  expect(card).toBeTruthy();
  failure = true; fireEvent.click(slot.getByRole("button", { name: "Refresh changes" }));
  await slot.findByRole("alert");
  expect(card!.hasAttribute("data-focused-diff-replacement")).toBe(false);
});
it("remembers repository disclosure across thread switches and remounts, scoped to the thread and plugin", async () => {
  const second = { ...repository, path: "/workspace/other", label: "other" };
  const state = () => ({ ...snapshot(), repositories: [repository, second] });
  const slot = await banner(state);
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  fireEvent.click(slot.getByRole("button", { name: "Collapse repository repos/cargo" }));
  await slot.behavior.setComposerScope({ kind: "thread", threadId: "two" });
  await slot.findByText("Changes");
  expect(slot.getByRole("button", { name: /^Changes/ }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getByRole("button", { name: "Collapse repository repos/cargo" })).toBeTruthy();
  await slot.behavior.setComposerScope({ kind: "thread", threadId: "one" });
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  expect(slot.getByRole("button", { name: "Expand repository repos/cargo" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Collapse repository other" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Expand repository repos/cargo" }));
  slot.lifecycle.unmount();
  const restored = await banner(state);
  await restored.findByText("Changes");
  fireEvent.click(restored.getByRole("button", { name: /^Changes/ }));
  expect(restored.getByRole("button", { name: "Collapse repository repos/cargo" })).toBeTruthy();
  fireEvent.click(restored.getByRole("button", { name: "Collapse repository repos/cargo" }));
  restored.lifecycle.unmount();
  const reloaded = await banner(state);
  await reloaded.findByText("Changes");
  fireEvent.click(reloaded.getByRole("button", { name: /^Changes/ }));
  expect(reloaded.getByRole("button", { name: "Expand repository repos/cargo" })).toBeTruthy();
  reloaded.lifecycle.unmount();
  const renamed = await banner(state, "one", "focused-diff-copy");
  await renamed.findByText("Changes");
  fireEvent.click(renamed.getByRole("button", { name: /^Changes/ }));
  expect(renamed.getByRole("button", { name: "Collapse repository repos/cargo" })).toBeTruthy();
});
it("keeps repository disclosure usable when browser storage is unavailable", async () => {
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new DOMException("Storage blocked", "SecurityError"); });
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
  const slot = await banner();
  await slot.findByText("Changes");
  fireEvent.click(slot.getByRole("button", { name: /^Changes/ }));
  fireEvent.click(slot.getByRole("button", { name: "Collapse repository repos/cargo" }));
  expect(slot.getByRole("button", { name: "Expand repository repos/cargo" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Expand repository repos/cargo" }));
  expect(slot.getByRole("button", { name: "Open Uncommitted diff for repos/cargo/Cargo.cs" })).toBeTruthy();
});
