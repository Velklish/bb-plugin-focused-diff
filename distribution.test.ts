import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("removes the builder's absolute virtual-source path while preserving source mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-map-"));
  try {
    await mkdir(join(root, "dist"));
    const sources = [`bb-zod-locale-stub:${root}/node_modules/zod/v4/locales/index.js`, "../server.ts"];
    const map = { version: 3, sources, sourcesContent: ["export {};", "source"], mappings: "AAAA", names: [] };
    await writeFile(join(root, "dist", "server.js.map"), JSON.stringify(map));
    execFileSync(process.execPath, [join(import.meta.dirname, "scripts/portable-maps.mjs")], { cwd: root });
    const actual = JSON.parse(await readFile(join(root, "dist", "server.js.map"), "utf8"));
    expect(actual).toEqual({ ...map, sources: ["bb-zod-locale-stub:../node_modules/zod/v4/locales/index.js", "../server.ts"] });
    expect(JSON.stringify(actual)).not.toContain(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
