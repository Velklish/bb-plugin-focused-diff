import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const name of readdirSync("dist").filter(name => name.endsWith(".map"))) {
  const path = join("dist", name);
  const map = JSON.parse(readFileSync(path, "utf8"));
  map.sources = map.sources.map(source => source.replaceAll("\\", "/").replace(/^bb-zod-locale-stub:.*\/node_modules\//, "bb-zod-locale-stub:../node_modules/"));
  writeFileSync(path, JSON.stringify(map));
}
