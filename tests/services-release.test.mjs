import assert from "node:assert/strict";
import test from "node:test";

import {
  isServicesTag,
  newestPrerelease,
} from "../scripts/check-preview-first.mjs";
import {
  nextServicesTag,
  parseBuildInfo,
  tagNamesFromLsRemote,
} from "../scripts/resolve-services-release.mjs";

const COMMIT = "53930a656e23cffef26c84925df769bf2e954fa1";

test("the first services release of a version is +s.1", () => {
  assert.equal(nextServicesTag("v0.4.0", ["v0.4.0", "v0.3.9+s.4"]), "v0.4.0+s.1");
});

test("services releases count up per editor version", () => {
  assert.equal(
    nextServicesTag("v0.4.0", ["v0.4.0", "v0.4.0+s.1", "v0.4.0+s.3", "v0.4.0+s.x"]),
    "v0.4.0+s.4",
  );
});

test("preview editors get services tags too", () => {
  assert.equal(
    nextServicesTag("v0.0.42-pre.20261105", ["v0.0.42-pre.20261105"]),
    "v0.0.42-pre.20261105+s.1",
  );
});

test("ls-remote output gives tag names without peeled suffixes", () => {
  const output = [
    `${COMMIT}\trefs/tags/v0.4.0`,
    `${COMMIT}\trefs/tags/v0.4.0^{}`,
    `${COMMIT}\trefs/tags/v0.4.0+s.2`,
    `${COMMIT}\trefs/heads/main`,
    "",
  ].join("\n");
  assert.deepEqual(tagNamesFromLsRemote(output), ["v0.4.0", "v0.4.0", "v0.4.0+s.2"]);
});

test("build-info gives the live editor commit and version", () => {
  assert.deepEqual(
    parseBuildInfo(JSON.stringify({ commit: COMMIT, version: "v0.4.0" }), "https://x"),
    { commit: COMMIT, version: "v0.4.0" },
  );
});

test("an editor without build-info.json cannot get a services release", () => {
  assert.throws(
    () => parseBuildInfo("<!doctype html>", "https://editor.counterpunch.space"),
    /ship a full release first/,
  );
});

test("a services tag cannot become the base of another services tag", () => {
  assert.throws(
    () => parseBuildInfo(JSON.stringify({ commit: COMMIT, version: "v0.4.0+s.1" }), "https://x"),
    /not a release version/,
  );
});

test("only <version>+s.N tags are services tags", () => {
  assert.equal(isServicesTag("v0.4.0+s.1"), true);
  assert.equal(isServicesTag("v0.0.42-pre.20261105+s.12"), true);
  assert.equal(isServicesTag("v0.4.0"), false);
  assert.equal(isServicesTag("v0.4.0+s.0"), false);
  assert.equal(isServicesTag("plugin-v1.0.0"), false);
});

test("the newest preview of either kind wins", () => {
  const editorPreview = {
    tagName: "v0.0.42-pre.20261105",
    isPrerelease: true,
    isDraft: false,
    publishedAt: "2026-11-05T13:20:00Z",
  };
  const servicesPreview = {
    tagName: "v0.0.42-pre.20261105+s.1",
    isPrerelease: true,
    isDraft: false,
    publishedAt: "2026-11-06T09:00:00Z",
  };
  assert.equal(newestPrerelease([editorPreview, servicesPreview]), servicesPreview);
});
