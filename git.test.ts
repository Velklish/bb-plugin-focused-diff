import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { collectChanges, MAX_TEXT_BYTES, readDiff, resolveRepositories } from "./git";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host";

const run = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function git(path: string, ...args: string[]) {
  return (await run("git", ["-C", path, ...args])).stdout;
}
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "Fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(path, "file.txt"), "original\n");
  await git(path, "add", "file.txt");
  await git(path, "commit", "-m", "fixture");
}
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "focused-diff-"));
  temporary.push(root);
  await repository(root);
  await writeFile(join(root, ".gitignore"), "/repos/\n/external/\n/sandbox/\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "ignore clones");
  return root;
}

describe("thread-scoped Git changes", () => {
  it("includes the current checkout and committed branch changes without registering the checkout", async () => {
    const root = await workspace(), repo = join(root, "repos", "cargo");
    await repository(repo);
    await git(repo, "checkout", "-b", "feature");
    await writeFile(join(repo, "file.txt"), "committed feature\n");
    await git(repo, "commit", "-am", "feature change");
    await writeFile(join(root, "file.txt"), "current checkout\n");
    const result = await collectChanges(root, [repo]);
    expect(result.repositories.map(repository => repository.path)).toEqual([await realpath(root), await realpath(repo)].sort());
    const canonical = await realpath(repo);
    expect(result.repositories.find(repository => repository.path === canonical)).toMatchObject({ baseBranch: "main", files: [expect.objectContaining({ path: "file.txt", layer: "committed", additions: 1, deletions: 1 })] });
  });
  it("shows the net working tree once and excludes staged changes cancelled in the working tree", async () => {
    const root = await workspace();
    await writeFile(join(root, "file.txt"), "staged\n");
    await git(root, "add", "file.txt");
    await writeFile(join(root, "file.txt"), "working\n");
    const changed = await collectChanges(root, []);
    expect(changed.repositories[0]?.files).toEqual([expect.objectContaining({ path: "file.txt", layer: "uncommitted", additions: 1, deletions: 1 })]);
    await writeFile(join(root, "file.txt"), "original\n");
    expect((await collectChanges(root, [])).repositories).toEqual([]);
  });
  it("finds changes in repositories ignored by the parent and preserves their indexes", async () => {
    const root = await workspace();
    const cargo = join(root, "repos", "team", "cargos-api");
    const personal = join(root, "external", "personal");
    await repository(cargo);
    await repository(personal);
    await writeFile(join(cargo, "file.txt"), "staged\n");
    await git(cargo, "add", "file.txt");
    await writeFile(join(cargo, "file.txt"), "unstaged\n");
    await writeFile(join(personal, "new.txt"), "new\nfile\n");
    const before = await readFile(join(cargo, ".git", "index"));
    expect(await git(root, "status", "--porcelain")).toBe("");
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("status", { rootPath: root, repositoryPaths: [cargo] });
    await harness.experimental_dispose();
    expect(result.repositories.map(repo => repo.path)).toEqual([await realpath(cargo)]);
    expect(result.repositories[0]?.files.map(file => file.layer)).toEqual(["uncommitted"]);
    expect(result.repositories.some(repo => repo.path === personal)).toBe(false);
    expect(await readFile(join(cargo, ".git", "index"))).toEqual(before);
    expect(await readFile(join(cargo, "file.txt"), "utf8")).toBe("unstaged\n");
  });
  it("resolves only edited paths, including deleted directories and Git worktrees", async () => {
    const root = await workspace();
    const repo = join(root, "repos", "cargo");
    const worktree = join(root, "sandbox", "cargo-worktree");
    await repository(repo);
    await git(repo, "worktree", "add", "-b", "feature", worktree);
    await writeFile(join(worktree, "file.txt"), "changed\n");
    const result = await resolveRepositories(root, [join(worktree, "deleted", "nested", "file.txt"), join(worktree, "file.txt"), "/etc/hosts"]);
    expect(result).toEqual({ repositories: [await realpath(worktree)], errors: [] });
    expect((await collectChanges(root, result.repositories)).repositories[0]).toMatchObject({ branch: "feature", label: "sandbox/cargo-worktree" });
  });
  it("preserves filenames, detects renames and respects the repository's own ignore rules", async () => {
    const root = await workspace(), repo = join(root, "external", "personal");
    await repository(repo);
    await git(repo, "mv", "file.txt", "новое имя.txt");
    await writeFile(join(repo, "line\nname.txt"), "one\ntwo");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "ignored.txt"), "ignored\n");
    const snapshot = await collectChanges(root, [repo]);
    const files = snapshot.repositories[0].files;
    expect(files.find(file => file.path === "новое имя.txt")).toMatchObject({ layer: "uncommitted", oldPath: "file.txt", additions: 0, deletions: 0 });
    expect(files.find(file => file.path === "line\nname.txt")).toMatchObject({ layer: "uncommitted", additions: 2 });
    expect(files.find(file => file.path === "binary.bin")?.binary).toBe(true);
    expect(files.some(file => file.path === "ignored.txt")).toBe(false);
    const renamed = await readDiff(root, repo, "новое имя.txt", "staged");
    expect(renamed.patch).toContain("rename from file.txt");
  });
  it("loads staged, unstaged, deleted and new-file patches without writing the index", async () => {
    const root = await workspace(), repo = join(root, "repos", "cargo");
    await repository(repo);
    await writeFile(join(repo, "file.txt"), "staged\n");
    await git(repo, "add", "file.txt");
    await writeFile(join(repo, "file.txt"), "working\n");
    const index = await readFile(join(repo, ".git", "index"));
    expect((await readDiff(root, repo, "file.txt", "staged")).patch).toContain("+staged");
    expect((await readDiff(root, repo, "file.txt", "unstaged")).patch).toContain("+working");
    await writeFile(join(repo, "new.txt"), "new without newline");
    const patch = await readDiff(root, repo, "new.txt", "untracked");
    expect(patch.patch).toContain("+new without newline");
    expect(patch.patch).toContain("\\ No newline at end of file");
    await rm(join(repo, "file.txt"));
    expect((await readDiff(root, repo, "file.txt", "unstaged")).patch).toContain("deleted file mode");
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  });
  it("rejects escaped paths and shows an explicit notice for binary and oversized files", async () => {
    const root = await workspace(), repo = join(root, "repos", "cargo");
    await repository(repo);
    await writeFile(join(repo, "binary"), Buffer.from([0, 2]));
    await writeFile(join(repo, "large"), "x".repeat(MAX_TEXT_BYTES + 1));
    await expect(readDiff(root, repo, "../file.txt", "untracked")).rejects.toThrow("inside the repository");
    await expect(readDiff(root, repo, ".git/config", "untracked")).rejects.toThrow("inside the repository");
    expect(await readDiff(root, repo, "binary", "untracked")).toMatchObject({ patch: null, binary: true, notice: "Binary file." });
    expect(await readDiff(root, repo, "large", "untracked")).toMatchObject({ patch: null, notice: "File exceeds 512 KiB." });
    await symlink("/etc/hosts", join(repo, "link"));
    const link = await readDiff(root, repo, "link", "untracked");
    expect(link.patch).toContain("+/etc/hosts");
    expect(link.patch).not.toContain("localhost");
    await symlink("/etc", join(root, "outside"));
    expect((await resolveRepositories(root, [join(root, "outside", "hosts")])).repositories).toEqual([]);
  });
  it("keeps a literal filename from opening a second file's diff", async () => {
    const root = await workspace(), repo = join(root, "repos", "cargo");
    await repository(repo);
    await writeFile(join(repo, "report[1].txt"), "original target\n");
    await writeFile(join(repo, "report1.txt"), "original other\n");
    await git(repo, "add", "report[1].txt", "report1.txt");
    await git(repo, "commit", "-m", "filenames");
    await writeFile(join(repo, "report[1].txt"), "target changed\n");
    await writeFile(join(repo, "report1.txt"), "other changed\n");
    const result = await readDiff(root, repo, "report[1].txt", "unstaged");
    expect(result.patch).toContain("+target changed");
    expect(result.patch).not.toContain("+other changed");
  });
  it("silently drops deleted tracked repositories on subsequent status reads", async () => {
    const root = await workspace(), repo = join(root, "sandbox", "temporary");
    await repository(repo);
    await writeFile(join(repo, "file.txt"), "changed\n");
    const harness = experimental_createHostEntryHarness(hostEntry);
    try {
      const input = { rootPath: root, repositoryPaths: [repo] };
      const before = await harness.experimental_call("status", input);
      expect(before.errors).toEqual([]);
      expect(before.repositories.map(repository => repository.path)).toEqual([await realpath(repo)]);
      await rm(repo, { recursive: true });
      for (let poll = 0; poll < 2; poll++) {
        expect(await harness.experimental_call("status", input)).toEqual({ repositories: [], errors: [] });
      }
    } finally { await harness.experimental_dispose(); }
  });
  it("does not replace a missing or replaced tracked repository with its parent or a symlink target", async () => {
    const root = await workspace(), repo = join(root, "repos", "cargo");
    await repository(repo);
    await writeFile(join(root, "file.txt"), "unrelated workspace change\n");
    await rm(repo, { recursive: true });
    const missing = await collectChanges(root, [repo]);
    expect(missing.repositories.map(repository => repository.path)).toEqual([await realpath(root)]);
    expect(missing.errors).toEqual([]);
    await mkdir(repo);
    const removedGit = await collectChanges(root, [repo]);
    expect(removedGit.repositories.map(repository => repository.path)).toEqual([await realpath(root)]);
    expect(removedGit.errors).toHaveLength(1);
    await rm(repo, { recursive: true });
    const other = join(root, "repos", "other");
    await repository(other);
    await writeFile(join(other, "file.txt"), "another repository\n");
    await symlink(other, repo);
    const replaced = await collectChanges(root, [repo]);
    expect(replaced.repositories.map(repository => repository.path)).toEqual([await realpath(root)]);
    expect(replaced.errors).toHaveLength(1);
  });
  it("reads net working and committed patches independently and preserves the index", async () => {
    const root = await workspace();
    await git(root, "checkout", "-b", "feature");
    await writeFile(join(root, "file.txt"), "committed\n");
    await git(root, "commit", "-am", "feature");
    await writeFile(join(root, "file.txt"), "staged\n");
    await git(root, "add", "file.txt");
    await writeFile(join(root, "file.txt"), "working\n");
    const index = await readFile(join(root, ".git", "index"));
    const net = await readDiff(root, root, "file.txt", "uncommitted");
    expect(net.patch).toContain("-committed\n+working");
    expect(net.patch).not.toContain("staged");
    const committed = await readDiff(root, root, "file.txt", "committed", undefined, "main");
    expect(committed.patch).toContain("-original\n+committed");
    expect(committed.patch).not.toContain("working");
    expect((await collectChanges(root, [root])).repositories[0].files).toHaveLength(2);
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
  });
  it("uses origin HEAD for a custom default branch and preserves committed renames", async () => {
    const root = await workspace();
    await git(root, "update-ref", "refs/remotes/origin/trunk", "main");
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    await git(root, "checkout", "-b", "feature");
    await git(root, "mv", "file.txt", "renamed.txt");
    await git(root, "commit", "-m", "rename");
    const repository = (await collectChanges(root, [])).repositories[0];
    expect(repository).toMatchObject({ baseBranch: "origin/trunk", files: [expect.objectContaining({ path: "renamed.txt", oldPath: "file.txt", layer: "committed" })] });
    expect((await readDiff(root, root, "renamed.txt", "committed", undefined, "origin/trunk")).patch).toContain("rename from file.txt");
  });
  it("shows working changes when the selected base is unavailable and rejects option-like refs", async () => {
    const root = await workspace();
    await writeFile(join(root, "file.txt"), "working\n");
    const repository = (await collectChanges(root, [], undefined, "missing-branch")).repositories[0];
    expect(repository.files).toHaveLength(1);
    expect(repository.comparisonError).toBe("Base branch missing-branch is unavailable.");
    await expect(readDiff(root, root, "file.txt", "committed", undefined, "--output=/tmp/unwanted")).rejects.toThrow("unavailable");
  });
  it("supports unborn repositories and includes the current contents of staged new files", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-diff-unborn-")); temporary.push(root);
    await git(root, "init", "-b", "main");
    await writeFile(join(root, "new.txt"), "staged\n");
    await git(root, "add", "new.txt");
    await writeFile(join(root, "new.txt"), "working\nsecond\n");
    const snapshot = await collectChanges(root, []);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.repositories[0]).toMatchObject({ comparisonError: null, files: [expect.objectContaining({ path: "new.txt", layer: "uncommitted", additions: 2, deletions: 0 })] });
    expect((await readDiff(root, root, "new.txt", "uncommitted")).patch).toContain("+working\n+second");
  });
  it("reconciles staged deletions with recreated untracked files into one net patch", async () => {
    const root = await workspace();
    await git(root, "rm", "file.txt");
    await writeFile(join(root, "file.txt"), "replacement\n");
    const files = (await collectChanges(root, [])).repositories[0].files;
    expect(files).toEqual([expect.objectContaining({ path: "file.txt", status: "M", additions: 1, deletions: 1 })]);
    const patch = (await readDiff(root, root, "file.txt", "uncommitted")).patch;
    expect(patch).toContain("--- a/file.txt\n+++ b/file.txt");
    expect(patch).toContain("-original\n+replacement");
    await writeFile(join(root, "file.txt"), "original\n");
    expect((await collectChanges(root, [])).repositories).toEqual([]);
  });
  it("reconciles recreated rename sources without hiding the renamed destination", async () => {
    const root = await workspace();
    await git(root, "mv", "file.txt", "renamed.txt");
    await writeFile(join(root, "file.txt"), "original\n");
    const files = (await collectChanges(root, [])).repositories[0].files;
    expect(files).toEqual([expect.objectContaining({ path: "renamed.txt", status: "A", oldPath: null, additions: 1, deletions: 0 })]);
    expect((await readDiff(root, root, "renamed.txt", "uncommitted")).patch).toContain("new file mode");
  });
  it("keeps unresolved conflicts visible even when the working file matches HEAD", async () => {
    const root = await workspace();
    await git(root, "checkout", "-b", "other");
    await writeFile(join(root, "file.txt"), "theirs\n"); await git(root, "commit", "-am", "other");
    await git(root, "checkout", "main");
    await writeFile(join(root, "file.txt"), "ours\n"); await git(root, "commit", "-am", "ours");
    await expect(git(root, "merge", "other")).rejects.toMatchObject({ code: 1 });
    await git(root, "checkout", "--ours", "--", "file.txt");
    const files = (await collectChanges(root, [])).repositories[0].files;
    expect(files).toEqual([expect.objectContaining({ path: "file.txt", status: "U", notice: "Unresolved merge conflict." })]);
    expect(await readDiff(root, root, "file.txt", "uncommitted")).toMatchObject({ patch: null, notice: "Unresolved merge conflict." });
  });
  it("bounds recreated files and compares symlink contents without reading their target", async () => {
    const root = await workspace();
    await git(root, "rm", "file.txt");
    await symlink("/etc/hosts", join(root, "file.txt"));
    const index = await readFile(join(root, ".git", "index"));
    const snapshot = await collectChanges(root, []);
    expect(snapshot.repositories[0].files).toEqual([expect.objectContaining({ path: "file.txt", additions: 1, deletions: 1 })]);
    const patch = (await readDiff(root, root, "file.txt", "uncommitted")).patch;
    expect(patch).toContain("+/etc/hosts"); expect(patch).not.toContain("localhost");
    await rm(join(root, "file.txt"));
    await writeFile(join(root, "file.txt"), "x".repeat(MAX_TEXT_BYTES + 1));
    expect(await readDiff(root, root, "file.txt", "uncommitted")).toMatchObject({ patch: null, notice: "Recreated file exceeds 512 KiB." });
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
  });
  it("applies repository CRLF normalization and core.fileMode to recreated files", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
    await git(root, "add", ".gitattributes"); await git(root, "commit", "-m", "attributes");
    await git(root, "config", "core.fileMode", "false");
    await git(root, "rm", "file.txt");
    await writeFile(join(root, "file.txt"), "original\r\n"); await chmod(join(root, "file.txt"), 0o755);
    expect((await collectChanges(root, [])).repositories).toEqual([]);
    await writeFile(join(root, "file.txt"), "replacement\r\n");
    expect((await collectChanges(root, [])).repositories[0].files).toEqual([expect.objectContaining({ additions: 1, deletions: 1 })]);
    expect((await readDiff(root, root, "file.txt", "uncommitted")).patch).toContain("-original\n+replacement");
  });
  it("honors repository binary attributes for recreated files", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitattributes"), "file.txt -diff\n");
    await git(root, "add", ".gitattributes"); await git(root, "commit", "-m", "binary attribute");
    await git(root, "rm", "file.txt"); await writeFile(join(root, "file.txt"), "replacement\n");
    expect((await collectChanges(root, [])).repositories[0].files).toEqual([expect.objectContaining({ binary: true, additions: 0, deletions: 0 })]);
    expect(await readDiff(root, root, "file.txt", "uncommitted")).toMatchObject({ patch: null, binary: true, notice: "Binary file." });
  });
  it("does not alter the real index or shared indexes while reconciling recreated files", async () => {
    const root = await workspace(); await git(root, "update-index", "--split-index");
    await git(root, "rm", "file.txt"); await writeFile(join(root, "file.txt"), "replacement\n");
    const names = (await readdir(join(root, ".git"))).filter(name => name === "index" || name.startsWith("sharedindex.")).sort();
    const before = await Promise.all(names.map(name => readFile(join(root, ".git", name))));
    expect((await readDiff(root, root, "file.txt", "uncommitted")).patch).toContain("+replacement");
    expect((await readdir(join(root, ".git"))).filter(name => name === "index" || name.startsWith("sharedindex.")).sort()).toEqual(names);
    expect(await Promise.all(names.map(name => readFile(join(root, ".git", name))))).toEqual(before);
  });
  it("does not execute index-write hooks while updating its private index", async () => {
    const root = await workspace();
    await git(root, "rm", "file.txt"); await writeFile(join(root, "file.txt"), "replacement\n");
    const hook = join(root, ".git", "hooks", "post-index-change");
    await writeFile(hook, "#!/bin/sh\nprintf called > hook-fired\n"); await chmod(hook, 0o755);
    expect((await readDiff(root, root, "file.txt", "uncommitted")).patch).toContain("+replacement");
    expect(await readdir(root)).not.toContain("hook-fired");
  });
});
