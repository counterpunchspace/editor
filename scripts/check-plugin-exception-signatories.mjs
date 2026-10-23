import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SIGNATORIES_PATH = "PLUGIN-EXCEPTION-SIGNATORIES";

const EXEMPT_LOGINS = new Set([
    "google-labs-jules[bot]",
    "factory-droid[bot]",
    "copilot",
    "cursor",
    "cursoragent",
]);

const EXEMPT_EMAILS = new Set([
    "138933559+factory-droid[bot]@users.noreply.github.com",
    "223556219+copilot@users.noreply.github.com",
    "cursoragent@cursor.com",
]);

function norm(login) {
    return String(login || "").toLowerCase();
}

export function isExempt(person) {
    const login = norm(person?.login);
    const email = String(person?.email || "").toLowerCase();
    if (login.endsWith("[bot]")) return true;
    if (EXEMPT_LOGINS.has(login)) return true;
    if (EXEMPT_EMAILS.has(email)) return true;
    return false;
}

export function loginFromNoreply(email) {
    const match = String(email || "").match(
        /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i,
    );
    return match ? match[1] : null;
}

export function coauthorsFromMessage(message) {
    const people = [];
    for (const line of String(message || "").split("\n")) {
        const match = line.match(/^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/i);
        if (!match) continue;
        const email = match[2].trim();
        people.push({ login: loginFromNoreply(email), email });
    }
    return people;
}

export function parseSignatories(text) {
    const lines = String(text || "").split("\n");
    const start = lines.findIndex((line) => line.trim() === "## Signatories");
    if (start < 0) {
        return {
            logins: [],
            error: "PLUGIN-EXCEPTION-SIGNATORIES has no ## Signatories heading.",
        };
    }
    const logins = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        logins.push(trimmed);
    }
    return { logins, error: "" };
}

export function evaluate({ baseLogins, headLogins, commits, actor }) {
    const failures = [];
    const head = new Set(headLogins.map(norm));
    const base = new Set(baseLogins.map(norm));
    const added = headLogins.filter((login) => !base.has(norm(login)));

    for (const commit of commits) {
        const people = [
            { login: commit.login, email: commit.email, role: "author" },
            ...(commit.coauthors || []).map((person) => ({
                ...person,
                role: "co-author",
            })),
        ];
        for (const person of people) {
            if (isExempt(person)) continue;
            if (!person.login) {
                failures.push(
                    `Commit ${commit.sha} ${person.role} email ${person.email || "(missing)"} is not a verified GitHub account.`,
                );
                continue;
            }
            if (!head.has(norm(person.login))) {
                failures.push(
                    `${person.login} has not granted the plugin exception. Add that login, in a commit by that account, to PLUGIN-EXCEPTION-SIGNATORIES.`,
                );
            }
        }
        const addedHere = commit.addedLogins || [];
        if (addedHere.length > 1) {
            failures.push(
                `Commit ${commit.sha} adds more than one signatory. A commit may add only its author's login.`,
            );
        }
        for (const login of addedHere) {
            if (norm(commit.login) !== norm(login)) {
                failures.push(
                    `${login} was added by ${commit.login || "an unverified author"} in ${commit.sha}, not by that account.`,
                );
            }
        }
    }

    if (actor) {
        for (const login of added) {
            if (norm(login) !== norm(actor)) {
                failures.push(
                    `${login} was not added by the pushing account ${actor}.`,
                );
            }
        }
    }

    const addedByCommits = new Set(
        commits.flatMap((commit) => (commit.addedLogins || []).map(norm)),
    );
    for (const login of added) {
        if (!addedByCommits.has(norm(login))) {
            failures.push(
                `${login} is new in PLUGIN-EXCEPTION-SIGNATORIES but no commit in this range adds it.`,
            );
        }
    }
    return failures;
}

function git(args) {
    return execFileSync("git", args, { encoding: "utf8" });
}

function fileAt(rev) {
    try {
        return git(["show", `${rev}:${SIGNATORIES_PATH}`]);
    } catch {
        return "";
    }
}

function loginsAddedByCommit(sha) {
    let parent = null;
    try {
        git(["rev-parse", "--verify", `${sha}^`]);
        parent = `${sha}^`;
    } catch {
        parent = null;
    }
    const before = new Set(parseSignatories(parent ? fileAt(parent) : "").logins.map(norm));
    return parseSignatories(fileAt(sha)).logins.filter(
        (login) => !before.has(norm(login)),
    );
}

function fromApiCommit(commit) {
    const message = commit.commit?.message || commit.message || "";
    const email = commit.commit?.author?.email || commit.author?.email || null;
    const login =
        commit.author?.login ||
        commit.author?.username ||
        loginFromNoreply(email);
    return {
        sha: commit.sha || commit.id,
        login: login || null,
        email,
        coauthors: coauthorsFromMessage(message),
        addedLogins: [],
    };
}

async function github(path) {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: {
            authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            accept: "application/vnd.github+json",
            "user-agent": "plugin-exception-signatories",
            "x-github-api-version": "2022-11-28",
        },
    });
    if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
}

async function pullRequestCommits(repo, number) {
    const commits = [];
    for (let page = 1; ; page += 1) {
        const batch = await github(
            `/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`,
        );
        commits.push(...batch.map(fromApiCommit));
        if (batch.length < 100) break;
    }
    return commits;
}

function ensureRev(rev) {
    try {
        git(["rev-parse", "--verify", `${rev}^{commit}`]);
    } catch {
        git(["fetch", "--depth=1", "origin", rev]);
    }
}

function finish(failures) {
    if (failures.length === 0) {
        console.log("Plugin exception signatories match the commits.");
        return;
    }
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
}

async function checkRange({ base, head, commits, actor }) {
    if (base) ensureRev(base);
    ensureRev(head);
    const baseFile = base ? fileAt(base) : "";
    const headFile = fileAt(head);
    const parsedHead = parseSignatories(headFile);
    const failures = [];
    if (parsedHead.error) failures.push(parsedHead.error);
    const parsedBase = parseSignatories(baseFile);
    for (const commit of commits) {
        commit.addedLogins = loginsAddedByCommit(commit.sha);
    }
    failures.push(
        ...evaluate({
            baseLogins: parsedBase.logins,
            headLogins: parsedHead.logins,
            commits,
            actor,
        }),
    );
    finish(failures);
}

async function checkPullRequest(event) {
    const pull = event.pull_request;
    const commits = await pullRequestCommits(
        process.env.GITHUB_REPOSITORY,
        pull.number,
    );
    await checkRange({
        base: pull.base.sha,
        head: pull.head.sha,
        commits,
    });
}

async function checkPush(event) {
    if (event.deleted) {
        console.log("Deleted branch. Skipping signatory check.");
        return;
    }
    const before = event.before;
    const after = event.after;
    const zero = /^0+$/.test(before || "");
    let commits;
    if (zero) {
        commits = (event.commits || []).map(fromApiCommit);
    } else {
        const compared = await github(
            `/repos/${process.env.GITHUB_REPOSITORY}/compare/${before}...${after}`,
        );
        commits = (compared.commits || []).map(fromApiCommit);
    }
    await checkRange({
        base: zero ? null : before,
        head: after,
        commits,
        actor: process.env.GITHUB_ACTOR,
    });
}

async function main() {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventName || !eventPath) {
        console.log("No GitHub event. Skipping signatory check.");
        return;
    }
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    if (eventName === "pull_request") {
        await checkPullRequest(event);
        return;
    }
    if (eventName === "push") {
        await checkPush(event);
        return;
    }
    console.log(`No signatory check for ${eventName}.`);
}

function isDirectRun() {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
    main().catch((error) => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}
