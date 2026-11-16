import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, FileDiff, Layer, RepositoryChanges } from "./contracts";

const run = promisify(execFile);
export const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2000;

async function git(cwd: string, args: string[], signal?: AbortSignal, diffExit = false, maxBuffer = 4 * 1024 * 1024, env?: NodeJS.ProcessEnv) {
  try {
    return (await run("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
      encoding: "utf8", signal, timeout: 10_000, maxBuffer, env,
    })).stdout;
  } catch (cause) {
    const error = cause as { code?: number | string; stdout?: string };
    if (diffExit && error.code === 1 && typeof error.stdout === "string") return error.stdout;
    throw cause;
  }
}
function inside(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
async function existingDirectory(path: string) {
  let candidate = path;
  while (true) {
    try {
      const info = await lstat(candidate);
      return realpath(info.isDirectory() ? candidate : dirname(candidate));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = dirname(candidate);
      if (parent === candidate) throw cause;
      candidate = parent;
    }
  }
}
async function scopeRoot(rootPath: string, signal?: AbortSignal) {
  if (!isAbsolute(rootPath)) throw new Error("Environment path must be absolute.");
  const root = await realpath(rootPath);
  try { return await realpath((await git(root, ["rev-parse", "--show-toplevel"], signal)).trim()); }
  catch (cause) {
    if (signal?.aborted || (cause as { code?: number }).code !== 128) throw cause;
    return root;
  }
}
export async function resolveRepositories(rootPath: string, paths: string[], signal?: AbortSignal) {
  const root = await scopeRoot(rootPath, signal);
  const environment = await realpath(rootPath);
  const repositories = new Set<string>();
  const errors: string[] = [];
  for (const path of paths) {
    const lexical = resolve(rootPath, path);
    const absolute = inside(rootPath, lexical) ? resolve(environment, relative(rootPath, lexical)) : lexical;
    if (!inside(root, absolute)) continue;
    try {
      const directory = await existingDirectory(absolute);
      if (!inside(root, directory)) continue;
      const repository = await realpath((await git(directory, ["rev-parse", "--show-toplevel"], signal)).trim());
      if (inside(root, repository)) repositories.add(repository);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      if ((cause as { code?: number }).code !== 128) errors.push(`${path}: ${message(cause)}`);
    }
  }
  if (repositories.size > 128) throw new Error("This thread exceeds the limit of 128 tracked repositories.");
  return { repositories: [...repositories].sort(), errors: errors.slice(0, 128) };
}
function message(cause: unknown) { return (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000); }

async function registeredRepository(rootPath: string, repositoryPath: string, signal?: AbortSignal) {
  if (!isAbsolute(repositoryPath)) throw new Error("Registered repository path must be absolute.");
  const environment = await realpath(rootPath), lexical = resolve(repositoryPath);
  const expected = inside(rootPath, lexical) ? resolve(environment, relative(rootPath, lexical)) : lexical;
  const canonical = await realpath(repositoryPath);
  if (canonical !== expected) throw new Error("Tracked repository path now resolves to a different location.");
  const { repositories } = await resolveRepositories(rootPath, [canonical], signal);
  if (!repositories.includes(canonical)) throw new Error("Tracked path is no longer a Git repository inside this environment.");
  return canonical;
}

function statusFiles(raw: string): ChangedFile[] {
  const records = raw.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2), path = record.slice(3);
    const oldPath = /[RC]/.test(status) ? records[++i] : null;
    const base = { path, oldPath, status, additions: 0, deletions: 0, binary: false, notice: null };
    if (status === "??") files.push({ ...base, layer: "untracked" });
    else if (status.includes("U") || status === "AA" || status === "DD") files.push({ ...base, layer: "unstaged" });
    else {
      if (status[0] !== " ") files.push({ ...base, layer: "staged" });
      if (status[1] !== " ") files.push({ ...base, oldPath: /[RC]/.test(status[1]) ? oldPath : null, layer: "unstaged" });
    }
  }
  return files;
}
function numstats(raw: string) {
  const parts = raw.split("\0"), stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const record = parts[i], first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
    let path = record.slice(second + 1);
    if (path === "") { i++; path = parts[++i]; }
    const add = record.slice(0, first), del = record.slice(first + 1, second);
    stats.set(path, { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del), binary: add === "-" });
  }
  return stats;
}
async function untrackedContent(repository: string, file: ChangedFile) {
  const path = resolve(repository, file.path), info = await lstat(path);
  if (info.size > MAX_TEXT_BYTES) return null;
  let content: Buffer;
  if (info.isSymbolicLink()) content = Buffer.from(await readlink(path));
  else {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_TEXT_BYTES) return null;
      content = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  return content;
}
async function untrackedInfo(repository: string, file: ChangedFile) {
  const content = await untrackedContent(repository, file);
  if (!content) return { notice: `File exceeds ${MAX_TEXT_BYTES / 1024} KiB.`, additions: 0, binary: false };
  const binary = content.includes(0);
  let additions = 0;
  if (!binary && content.length) {
    for (const byte of content) if (byte === 10) additions++;
    if (content[content.length - 1] !== 10) additions++;
  }
  return { binary, additions, notice: binary ? "Binary file." : null };
}
async function commitRef(repository: string, ref: string, signal?: AbortSignal) {
  try { return (await git(repository, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], signal)).trim(); }
  catch (cause) { if ((cause as { code?: number }).code === 1) return null; throw cause; }
}
function namedFiles(raw: string, layer: Layer): ChangedFile[] {
  const parts = raw.split("\0"), files: ChangedFile[] = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++], firstPath = parts[i++];
    const renamed = /^[RC]/.test(status);
    files.push({ path: renamed ? parts[i++] : firstPath, oldPath: renamed ? firstPath : null, layer, status: status[0], additions: 0, deletions: 0, binary: false, notice: null });
  }
  return files;
}
const diffOptions = ["--no-ext-diff", "--no-textconv", "--find-renames"];
async function comparisonFiles(repository: string, refs: string[], layer: Layer, signal?: AbortSignal) {
  const [names, counts] = await Promise.all([
    git(repository, ["diff", ...diffOptions, "--name-status", "-z", ...refs], signal),
    git(repository, ["diff", ...diffOptions, "--numstat", "-z", ...refs], signal),
  ]);
  const files = namedFiles(names, layer), tallies = numstats(counts);
  for (const file of files) Object.assign(file, tallies.get(file.path));
  return files;
}
async function recreatedChange(repository: string, file: ChangedFile, head: string, signal?: AbortSignal) {
  const empty = { patch: null, notice: null, binary: false, additions: 0, deletions: 0 };
  const entry = await git(repository, ["ls-tree", "-z", head, "--", file.path], signal);
  const [mode, type, blob] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (type !== "blob") return { ...empty, notice: "Recreated path was not a regular file or symlink." };
  const current = await untrackedContent(repository, file);
  if (!current) return { ...empty, notice: "Recreated file exceeds 512 KiB." };
  const temporary = await mkdtemp(join(tmpdir(), "focused-diff-recreated-"));
  try {
    const index = join(temporary, "index"), sourceIndex = (await git(repository, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal)).trim();
    await copyFile(sourceIndex, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(repository, ["-c", "core.splitIndex=false", "-c", `core.hooksPath=${temporary}`, "update-index", "--no-split-index", "--add", "--cacheinfo", mode, blob, file.path], signal, false, 4 * 1024 * 1024, env);
    const args = ["diff", ...diffOptions], paths = ["--", file.path];
    const [patch, counts] = await Promise.all([
      git(repository, [...args, ...paths], signal, false, MAX_PATCH_BYTES, env),
      git(repository, [...args, "--numstat", "-z", ...paths], signal, false, 4 * 1024 * 1024, env),
    ]);
    const tally = [...numstats(counts).values()].reduce((sum, value) => ({ additions: sum.additions + value.additions, deletions: sum.deletions + value.deletions, binary: sum.binary || value.binary }), { additions: 0, deletions: 0, binary: false });
    return { ...tally, patch: tally.binary || !patch ? null : patch, notice: tally.binary ? "Binary file." : null };
  } catch (cause) {
    if ((cause as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { ...empty, notice: "Diff exceeds 2 MiB." };
    throw cause;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function uncommitted(repository: string, signal?: AbortSignal): { list(): Promise<ChangedFile[]>; diff(path: string): Promise<FileDiff> } {
  type Candidate = { file: ChangedFile; comparison: "tracked" | "new" | "unborn" | "recreated" };

  async function discover(withCounts: boolean) {
    const [status, head] = await Promise.all([
      git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
      commitRef(repository, "HEAD", signal),
    ]);
    const refs = head ? [head] : ["--cached"];
    const files = withCounts
      ? await comparisonFiles(repository, refs, "uncommitted", signal)
      : namedFiles(await git(repository, ["diff", ...diffOptions, "--name-status", "-z", ...refs], signal), "uncommitted");
    const porcelain = statusFiles(status);
    if (new Set([...files, ...porcelain].map(file => file.path)).size > MAX_FILES) throw new Error(`Repository exceeds the limit of ${MAX_FILES} change entries.`);
    const candidates: Candidate[] = files.map(file => ({ file, comparison: head ? "tracked" : "unborn" }));
    for (const untracked of porcelain.filter(file => file.layer === "untracked")) {
      const deletion = candidates.findIndex(({ file }) => file.path === untracked.path && file.status === "D");
      const rename = candidates.find(({ file }) => file.oldPath === untracked.path && file.status === "R");
      if (rename) {
        Object.assign(rename.file, { oldPath: null, status: "A" });
        rename.comparison = "new";
      }
      if (head && (deletion >= 0 || rename)) {
        if (deletion >= 0) candidates.splice(deletion, 1);
        candidates.push({ file: { ...untracked, layer: "uncommitted", status: "M" }, comparison: "recreated" });
      } else candidates.push({ file: { ...untracked, layer: "uncommitted" }, comparison: "new" });
    }
    for (const conflict of porcelain.filter(file => file.status.includes("U") || file.status === "AA" || file.status === "DD")) {
      const existing = candidates.find(({ file }) => file.path === conflict.path);
      if (existing) Object.assign(existing.file, { status: "U", notice: "Unresolved merge conflict." });
      else candidates.push({ file: { ...conflict, layer: "uncommitted", status: "U", notice: "Unresolved merge conflict." }, comparison: "tracked" });
    }
    return { candidates, head };
  }

  async function evaluate({ file, comparison }: Candidate, head: string | null): Promise<{ file: ChangedFile; diff?: FileDiff } | null> {
    signal?.throwIfAborted();
    if (comparison === "recreated") {
      const { patch, ...info } = await recreatedChange(repository, file, head!, signal);
      if (!patch && !info.notice) return null;
      return { file: { ...file, ...info }, diff: { patch, notice: info.notice, binary: info.binary } };
    }
    if (comparison === "new" || comparison === "unborn") {
      try {
        const info = await untrackedInfo(repository, file);
        return {
          file: { ...file, ...info, notice: file.notice ?? info.notice },
          ...(info.notice ? { diff: { patch: null, notice: info.notice, binary: info.binary } } : {}),
        };
      }
      catch (cause) { if (comparison === "unborn" && (cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
    }
    return { file };
  }

  return {
    async list() {
      const { candidates, head } = await discover(true), files: ChangedFile[] = [];
      for (const candidate of candidates) {
        const result = await evaluate(candidate, head);
        if (result) files.push(result.file);
      }
      if (files.length > MAX_FILES) throw new Error(`Repository exceeds the limit of ${MAX_FILES} change entries.`);
      return files;
    },
    async diff(path) {
      const { candidates, head } = await discover(false);
      const candidate = candidates.find(({ file }) => file.path === path);
      if (!candidate) return missingChange();
      const result = await evaluate(candidate, head);
      if (!result) return missingChange();
      if (result.diff) return result.diff;
      const newFile = candidate.comparison === "new" || candidate.comparison === "unborn";
      return filePatch(repository, result.file, head ? [head] : [], signal, newFile);
    },
  };
}
async function comparisonBase(repository: string, configured: string | null | undefined, signal?: AbortSignal) {
  if (configured) {
    const commit = await commitRef(repository, configured, signal);
    if (!commit) throw new Error(`Base branch ${configured} is unavailable.`);
    return { branch: configured, commit };
  }
  let remoteHead = "";
  try { remoteHead = (await git(repository, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], signal)).trim(); }
  catch (cause) { if ((cause as { code?: number }).code !== 1) throw cause; }
  for (const branch of [remoteHead, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    const commit = await commitRef(repository, branch, signal);
    if (commit) return { branch, commit };
  }
  return null;
}
async function mergeBase(repository: string, base: string, signal?: AbortSignal) {
  try { return (await git(repository, ["merge-base", "HEAD", base], signal)).trim(); }
  catch (cause) { if ((cause as { code?: number }).code === 1) throw new Error("The base branch and HEAD have no common ancestor."); throw cause; }
}
async function readRepository(repository: string, signal?: AbortSignal, configuredBase?: string | null): Promise<RepositoryChanges> {
  const [files, branch, head] = await Promise.all([uncommitted(repository, signal).list(), git(repository, ["branch", "--show-current"], signal), commitRef(repository, "HEAD", signal)]);
  let baseBranch: string | null = null, comparisonError: string | null = null;
  if (head) {
    try {
      const base = await comparisonBase(repository, configuredBase, signal);
      if (base) {
        baseBranch = base.branch;
        files.push(...await comparisonFiles(repository, [await mergeBase(repository, base.commit, signal), head], "committed", signal));
      }
    } catch (cause) { if (signal?.aborted) throw cause; comparisonError = message(cause); }
  }
  if (files.length > MAX_FILES) throw new Error(`Repository exceeds the limit of ${MAX_FILES} change entries.`);
  return { path: repository, label: repository, branch: branch.trim() || "detached HEAD", files, baseBranch, comparisonError };
}
export async function collectChanges(rootPath: string, repositoryPaths: string[], signal?: AbortSignal, mergeBaseBranch?: string | null) {
  const root = await scopeRoot(rootPath, signal);
  const current = await resolveRepositories(rootPath, [rootPath], signal);
  const repositories: RepositoryChanges[] = [], errors: string[] = [...current.errors];
  for (const requested of [...new Set([...current.repositories, ...repositoryPaths])].sort()) {
    try {
      const path = await registeredRepository(rootPath, requested, signal);
      const repository = await readRepository(path, signal, current.repositories.includes(path) ? mergeBaseBranch : undefined);
      if (repository.files.length || repository.comparisonError) repositories.push({ ...repository, label: relative(root, path) || basename(path) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`${relative(root, requested) || "."}: ${message(cause)}`);
    }
  }
  return { repositories, errors: errors.slice(0, 128) };
}
export async function readDiff(rootPath: string, repositoryPath: string, path: string, layer: Layer, signal?: AbortSignal, baseBranch?: string): Promise<FileDiff> {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git")) throw new Error("File path must stay inside the repository.");
  const repository = await registeredRepository(rootPath, repositoryPath, signal);
  if (layer === "uncommitted") return uncommitted(repository, signal).diff(path);
  let refs: string[] = [];
  let files: ChangedFile[];
  if (layer === "committed") {
    const base = await comparisonBase(repository, baseBranch, signal);
    if (!base) return { patch: null, notice: "No base branch is available.", binary: false };
    refs = [await mergeBase(repository, base.commit, signal), "HEAD"];
    files = await comparisonFiles(repository, refs, layer, signal);
  } else files = statusFiles(await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal));
  const file = files.find(file => file.path === path && file.layer === layer);
  if (!file) return missingChange();
  const newFile = layer === "untracked";
  if (newFile) {
    const info = await untrackedInfo(repository, file);
    if (info.notice) return { patch: null, notice: info.notice, binary: info.binary };
  }
  return filePatch(repository, file, layer === "staged" ? ["--cached"] : refs, signal, newFile);
}
function missingChange(): FileDiff { return { patch: null, notice: "This change is no longer present. Refresh the list.", binary: false }; }
async function filePatch(repository: string, file: ChangedFile, refs: string[], signal?: AbortSignal, newFile = false): Promise<FileDiff> {
  const args = newFile
    ? ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", process.platform === "win32" ? "NUL" : "/dev/null", file.path]
    : ["diff", ...refs, ...diffOptions, "--", ...(file.oldPath ? [file.oldPath] : []), file.path];
  try {
    const patch = await git(repository, args, signal, newFile, MAX_PATCH_BYTES);
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) return { patch: null, notice: "Diff exceeds 2 MiB.", binary: false };
    const binary = /^Binary files /m.test(patch);
    return { patch: binary ? null : patch || null, notice: binary ? "Binary file." : file.notice || (patch ? null : "Empty diff."), binary };
  } catch (cause) {
    if ((cause as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { patch: null, notice: "Diff exceeds 2 MiB.", binary: false };
    throw cause;
  }
}
