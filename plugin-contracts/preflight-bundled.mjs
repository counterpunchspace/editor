import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWheel } from "./static-wheel.mjs";

const editorRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const roots = [join(editorRoot, "plugins"), join(editorRoot, "webapp/language-packs")];

function wheels(dir) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...wheels(path));
    else if (name.endsWith(".whl")) found.push(path);
  }
  return found;
}

let failed = false;
for (const path of roots.flatMap(wheels)) {
  const filename = path.split("/").pop();
  const result = inspectWheel(readFileSync(path), filename);
  const relevant = result.failures.filter((failure) => !failure.startsWith("filename does not start"));
  if (relevant.length) {
    failed = true;
    console.error(`${filename}: ${relevant.join("; ")}`);
  } else {
    console.log(`${filename}: static preflight ok (${result.name} ${result.version})`);
  }
}
process.exit(failed ? 1 : 0);
