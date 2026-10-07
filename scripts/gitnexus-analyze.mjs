import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(
    new URL("../node_modules/.bin/gitnexus", import.meta.url),
);
const attempts = 3;

function analyze() {
    return new Promise((resolve) => {
        const child = spawn(bin, ["analyze"], { cwd: root, stdio: "inherit" });
        child.on("error", () => resolve(false));
        child.on("exit", (code, signal) => {
            resolve(code === 0 && !signal);
        });
    });
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await analyze()) {
        process.exit(0);
    }
    console.error(
        `gitnexus analyze failed (attempt ${attempt}/${attempts})`,
    );
    rmSync(new URL("../.gitnexus", import.meta.url), {
        recursive: true,
        force: true,
    });
}

process.exit(1);
