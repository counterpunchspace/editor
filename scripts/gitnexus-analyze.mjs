import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(
    new URL("../node_modules/.bin/gitnexus", import.meta.url),
);
const attempts = 3;

function analyze() {
    return new Promise((resolve) => {
        const child = spawn(bin, ["analyze", "--skip-agents-md"], {
            cwd: root,
            stdio: "inherit",
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code, signal) => {
            resolve(code === 0 && !signal);
        });
    });
}

/**
 * True when LadybugDB's extension server does not serve the extensions every
 * analyze installs. A fresh CI runner downloads them, and when that server is
 * down the native engine crashes after the failed install.
 */
async function extensionServerDown() {
    try {
        const pkg = JSON.parse(
            readFileSync(
                new URL(
                    "../node_modules/@ladybugdb/core/package.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        );
        const [major, minor] = String(pkg.version).split(".");
        const base = `https://extension.ladybugdb.com/v${major}.${minor}.0/linux_amd64`;
        for (const name of ["fts", "vector"]) {
            const response = await fetch(
                `${base}/${name}/lib${name}.lbug_extension`,
                { method: "HEAD" },
            );
            if (response.ok) {
                return false;
            }
        }
        return true;
    } catch {
        return true;
    }
}

// In CI only (checked first, since each failed attempt takes minutes): an
// outage of that server must not also skip tsc, Jest and the
// other checks chained after this step. The graph chokepoint check reads the
// marker and skips only its graph queries, loudly.
if (process.env.CI && (await extensionServerDown())) {
    writeFileSync(
        new URL("../.gitnexus-extension-outage", import.meta.url),
        new Date().toISOString(),
    );
    console.log(
        "::warning::GitNexus could not index: LadybugDB's extension server is down. Graph chokepoint queries are skipped for this run.",
    );
    process.exit(0);
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await analyze()) {
        process.exit(0);
    }
    console.error(`gitnexus analyze failed (attempt ${attempt}/${attempts})`);
    rmSync(new URL("../.gitnexus", import.meta.url), {
        recursive: true,
        force: true,
    });
}

process.exit(1);
