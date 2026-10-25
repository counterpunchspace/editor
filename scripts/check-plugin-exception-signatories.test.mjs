import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "./check-plugin-exception-signatories.mjs";

test("a listed author passes", () => {
    const failures = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone"],
        commits: [
            {
                sha: "a",
                login: "yanone",
                email: "post@yanone.de",
                coauthors: [],
                addedLogins: [],
            },
        ],
    });
    assert.deepEqual(failures, []);
});

test("an unlisted author fails", () => {
    const failures = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone"],
        commits: [
            {
                sha: "b",
                login: "simoncozens",
                email: "simon@simon-cozens.org",
                coauthors: [],
                addedLogins: [],
            },
        ],
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /simoncozens/);
});

test("an added login passes only when that account authored the commit", () => {
    const pass = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone", "simoncozens"],
        commits: [
            {
                sha: "c",
                login: "simoncozens",
                email: "simon@simon-cozens.org",
                coauthors: [],
                addedLogins: ["simoncozens"],
            },
        ],
    });
    assert.deepEqual(pass, []);

    const fail = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone", "simoncozens"],
        commits: [
            {
                sha: "d",
                login: "yanone",
                email: "post@yanone.de",
                coauthors: [],
                addedLogins: ["simoncozens"],
            },
        ],
    });
    assert.match(fail.join("\n"), /simoncozens was added by yanone/);
});

test("a second login in the same commit fails", () => {
    const failures = evaluate({
        baseLogins: [],
        headLogins: ["yanone", "simoncozens"],
        commits: [
            {
                sha: "e",
                login: "yanone",
                email: "post@yanone.de",
                coauthors: [],
                addedLogins: ["yanone", "simoncozens"],
            },
        ],
    });
    assert.match(failures.join("\n"), /more than one signatory/);
});

test("google-labs-jules[bot] passes without being listed", () => {
    const failures = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone"],
        commits: [
            {
                sha: "f",
                login: "google-labs-jules[bot]",
                email: "161369871+google-labs-jules[bot]@users.noreply.github.com",
                coauthors: [],
                addedLogins: [],
            },
        ],
    });
    assert.deepEqual(failures, []);
});

test("a Cursor co-author passes without being listed", () => {
    const failures = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone"],
        commits: [
            {
                sha: "g",
                login: "yanone",
                email: "post@yanone.de",
                coauthors: [
                    { login: null, email: "cursoragent@cursor.com" },
                ],
                addedLogins: [],
            },
        ],
    });
    assert.deepEqual(failures, []);
});

test("a Claude co-author passes without being listed", () => {
    const failures = evaluate({
        baseLogins: ["yanone"],
        headLogins: ["yanone"],
        commits: [
            {
                sha: "h",
                login: "yanone",
                email: "post@yanone.de",
                coauthors: [{ login: null, email: "noreply@anthropic.com" }],
                addedLogins: [],
            },
        ],
    });
    assert.deepEqual(failures, []);
});
