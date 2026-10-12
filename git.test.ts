import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    expect(result.repositories[0]?.files.map(file => file.layer)).toEqual(["staged", "unstaged"]);
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
    expect(files.find(file => file.path === "новое имя.txt")).toMatchObject({ layer: "staged", oldPath: "file.txt", additions: 0, deletions: 0 });
    expect(files.find(file => file.path === "line\nname.txt")).toMatchObject({ layer: "untracked", additions: 2 });
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
  it("does not replace a missing or replaced tracked repository with its parent or a symlink target", async () => {
    const root = await workspace(), repo = join(root, "repos", "cargo");
    await repository(repo);
    await writeFile(join(root, "file.txt"), "unrelated workspace change\n");
    await rm(repo, { recursive: true });
    const missing = await collectChanges(root, [repo]);
    expect(missing.repositories).toEqual([]);
    expect(missing.errors).toHaveLength(1);
    await mkdir(repo);
    const removedGit = await collectChanges(root, [repo]);
    expect(removedGit.repositories).toEqual([]);
    expect(removedGit.errors).toHaveLength(1);
    await rm(repo, { recursive: true });
    const other = join(root, "repos", "other");
    await repository(other);
    await writeFile(join(other, "file.txt"), "another repository\n");
    await symlink(other, repo);
    const replaced = await collectChanges(root, [repo]);
    expect(replaced.repositories).toEqual([]);
    expect(replaced.errors).toHaveLength(1);
  });
});
