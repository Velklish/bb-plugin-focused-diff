import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, FileDiff, Layer, RepositoryChanges } from "./contracts";

const run = promisify(execFile);
export const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2000;

async function git(cwd: string, args: string[], signal?: AbortSignal, diffExit = false, maxBuffer = 4 * 1024 * 1024) {
  try {
    return (await run("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
      encoding: "utf8", signal, timeout: 10_000, maxBuffer,
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
async function untrackedInfo(repository: string, file: ChangedFile) {
  const path = resolve(repository, file.path), info = await lstat(path);
  if (info.size > MAX_TEXT_BYTES) return { notice: `File exceeds ${MAX_TEXT_BYTES / 1024} KiB.`, additions: 0, binary: false };
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
      if (bytesRead > MAX_TEXT_BYTES) return { notice: `File exceeds ${MAX_TEXT_BYTES / 1024} KiB.`, additions: 0, binary: false };
      content = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  const binary = content.includes(0);
  let additions = 0;
  if (!binary && content.length) {
    for (const byte of content) if (byte === 10) additions++;
    if (content[content.length - 1] !== 10) additions++;
  }
  return { binary, additions, notice: binary ? "Binary file." : null };
}
async function readRepository(repository: string, signal?: AbortSignal): Promise<RepositoryChanges> {
  const [status, staged, unstaged, branch] = await Promise.all([
    git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
    git(repository, ["diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--find-renames"], signal),
    git(repository, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--find-renames"], signal),
    git(repository, ["branch", "--show-current"], signal),
  ]);
  const files = statusFiles(status);
  if (files.length > MAX_FILES) throw new Error(`Repository exceeds the limit of ${MAX_FILES} change entries.`);
  const tallies = { staged: numstats(staged), unstaged: numstats(unstaged) };
  for (const file of files) {
    signal?.throwIfAborted();
    if (file.layer === "untracked") Object.assign(file, await untrackedInfo(repository, file));
    else Object.assign(file, tallies[file.layer].get(file.path));
  }
  return { path: repository, label: repository, branch: branch.trim() || "detached HEAD", files };
}
export async function collectChanges(rootPath: string, repositoryPaths: string[], signal?: AbortSignal) {
  const root = await scopeRoot(rootPath, signal);
  const repositories: RepositoryChanges[] = [], errors: string[] = [];
  for (const requested of [...new Set(repositoryPaths)].sort()) {
    try {
      const path = await registeredRepository(rootPath, requested, signal);
      const repository = await readRepository(path, signal);
      if (repository.files.length) repositories.push({ ...repository, label: relative(root, path) || basename(path) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      errors.push(`${relative(root, requested) || "."}: ${message(cause)}`);
    }
  }
  return { repositories, errors: errors.slice(0, 128) };
}
export async function readDiff(rootPath: string, repositoryPath: string, path: string, layer: Layer, signal?: AbortSignal): Promise<FileDiff> {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git")) throw new Error("File path must stay inside the repository.");
  const repository = await registeredRepository(rootPath, repositoryPath, signal);
  const files = statusFiles(await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal));
  const file = files.find(file => file.path === path && file.layer === layer);
  if (!file) return { patch: null, notice: "This change is no longer present. Refresh the list.", binary: false };
  if (layer === "untracked") {
    const info = await untrackedInfo(repository, file);
    if (info.notice) return { patch: null, notice: info.notice, binary: info.binary };
  }
  const args = layer === "untracked"
    ? ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", process.platform === "win32" ? "NUL" : "/dev/null", path]
    : ["diff", ...(layer === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--find-renames", "--", ...(file.oldPath ? [file.oldPath] : []), path];
  try {
    const patch = await git(repository, args, signal, layer === "untracked", MAX_PATCH_BYTES);
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) return { patch: null, notice: "Diff exceeds 2 MiB.", binary: false };
    const binary = /^Binary files /m.test(patch);
    return { patch: binary ? null : patch, notice: binary ? "Binary file." : patch ? null : "Empty diff.", binary };
  } catch (cause) {
    if ((cause as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { patch: null, notice: "Diff exceeds 2 MiB.", binary: false };
    throw cause;
  }
}
