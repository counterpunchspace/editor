import { spawn } from "node:child_process";

const PROBE_MS = 5000;
const TOTAL_MS = 60000;
const RSS_BYTES = 768 * 1024 * 1024;
const REPORT_MAX = 256 * 1024;
const LOG_MAX = 16 * 1024;

function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

export function supervise(command, args, options = {}) {
  const probeMs = options.probeMs ?? PROBE_MS;
  const totalMs = options.totalMs ?? TOTAL_MS;
  const rssBytes = options.rssBytes ?? RSS_BYTES;
  const started = Date.now();
  let lastProbeAt = started;
  let lastProbe = "";
  let stdout = "";
  let stderr = "";
  let settled = false;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function finish(outcome, extra = {}) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      const reportLine = stdout.split("\n").find((line) => line.startsWith("REPORT "));
      let report = null;
      if (reportLine) {
        const raw = reportLine.slice("REPORT ".length);
        if (raw.length > REPORT_MAX) {
          resolve({
            outcome: "oversized_output",
            lastProbe,
            stdout: clip(stdout, LOG_MAX),
            stderr: clip(stderr, LOG_MAX),
            report: null,
          });
          return;
        }
        try {
          report = JSON.parse(raw);
        } catch {
          report = null;
        }
      }
      resolve({
        outcome,
        lastProbe,
        stdout: clip(stdout, LOG_MAX),
        stderr: clip(stderr, LOG_MAX),
        report,
        ...extra,
      });
    }

    function kill(outcome) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(outcome);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > REPORT_MAX + LOG_MAX) {
        kill("oversized_output");
        return;
      }
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.startsWith("PROBE ")) {
          lastProbeAt = Date.now();
          lastProbe = line.slice("PROBE ".length).trim();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > LOG_MAX * 2) stderr = stderr.slice(-LOG_MAX);
    });
    child.on("error", (error) => finish("crashed", { error: String(error) }));
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (signal === "SIGKILL") return;
      if (code === 0 && reportOk(stdout)) finish("passed");
      else if (code === 0) finish("failed");
      else finish("failed");
    });

    const timer = setInterval(() => {
      const now = Date.now();
      if (now - started > totalMs) {
        kill("timeout");
        return;
      }
      if (now - lastProbeAt > probeMs) {
        kill("timeout");
        return;
      }
      if (typeof child.pid === "number") {
        readRss(child.pid).then((rss) => {
          if (rss > rssBytes) kill("memory_exceeded");
        }).catch(() => {});
      }
    }, options.pollMs ?? 200);
  });
}

function reportOk(stdout) {
  const line = stdout.split("\n").find((item) => item.startsWith("REPORT "));
  if (!line) return false;
  try {
    return JSON.parse(line.slice("REPORT ".length)).passed === true;
  } catch {
    return false;
  }
}

async function readRss(pid) {
  const { readFile } = await import("node:fs/promises");
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
  if (!match) return 0;
  return Number(match[1]) * 1024;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const result = await supervise(command, args);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.outcome === "passed" ? 0 : 1);
}
