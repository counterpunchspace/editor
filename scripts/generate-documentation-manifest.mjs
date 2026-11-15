#!/usr/bin/env node
/**
 * Build documentation/manifest.json from the handbook folder tree.
 * Folders are TOC groups. Markdown files are pages. Numeric filename
 * prefixes sort entries and are stripped from stable ids.
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { posix as pathPosix } from "path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DOCUMENTATION_ROOT = join(SCRIPT_DIR, "..", "documentation");

const SKIP_NAMES = new Set(["readme.md", "manifest.json"]);
const PREFIX_PATTERN = /^(\d+)-/;
const ROOT_ORDER = [
    "getting-started",
    "type-design",
    "files",
    "migrate",
    "editor",
    "features",
    "overview",
    "python",
    "ai",
    "reference",
    "troubleshooting",
    "acknowledgements",
];

/**
 * @param {string} name
 * @returns {string}
 */
export function stripNumericPrefix(name) {
    return name.replace(PREFIX_PATTERN, "");
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
export function pageIdFromRelativePath(relativePath) {
    const withoutExt = relativePath.replace(/\.md$/i, "");
    const parts = withoutExt.split("/").map((part) => stripNumericPrefix(part));
    if (parts[parts.length - 1] === "index") {
        parts.pop();
    }
    return parts.join("/");
}

/**
 * @param {string} folderName
 * @returns {string}
 */
export function titleFromFolderName(folderName) {
    const slug = stripNumericPrefix(folderName);
    if (slug === "ai") {
        return "AI assistant";
    }
    return slug
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

/**
 * @param {string} markdown
 * @param {string} fallback
 * @returns {string}
 */
export function titleFromMarkdown(markdown, fallback) {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : fallback;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function shouldSkipName(name) {
    const lower = name.toLowerCase();
    return SKIP_NAMES.has(lower) || lower.startsWith(".");
}

/**
 * @param {string} rootDir
 * @param {string} relativeDir
 * @returns {Promise<import('fs').Dirent[]>}
 */
async function readSortedEntries(rootDir, relativeDir) {
    const absoluteDir = join(rootDir, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    return entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
        }),
    );
}

/**
 * @param {string} name
 * @returns {number}
 */
function rootOrderIndex(name) {
    const key = stripNumericPrefix(name.replace(/\.md$/i, ""));
    const index = ROOT_ORDER.indexOf(key);
    return index === -1 ? ROOT_ORDER.length : index;
}

/**
 * @param {string} rootDir
 * @param {string} relativeDir
 * @returns {Promise<object[]>}
 */
async function collectNodes(rootDir, relativeDir) {
    const entries = await readSortedEntries(rootDir, relativeDir);
    if (!relativeDir) {
        entries.sort((a, b) => {
            const order = rootOrderIndex(a.name) - rootOrderIndex(b.name);
            if (order !== 0) {
                return order;
            }
            return a.name.localeCompare(b.name, undefined, {
                numeric: true,
                sensitivity: "base",
            });
        });
    }
    /** @type {object[]} */
    const nodes = [];

    for (const entry of entries) {
        if (shouldSkipName(entry.name)) {
            continue;
        }

        const relPath = relativeDir
            ? pathPosix.join(relativeDir, entry.name)
            : entry.name;

        if (entry.isDirectory()) {
            if (entry.name === "images" || entry.name === "assets") {
                continue;
            }
            const children = await collectNodes(rootDir, relPath);
            const indexChild = children.find(
                (child) =>
                    child.kind === "page" && child.path?.endsWith("/index.md"),
            );
            const sectionTitle = indexChild
                ? indexChild.title
                : titleFromFolderName(entry.name);
            nodes.push({
                id: pageIdFromRelativePath(relPath + "/index.md"),
                title: sectionTitle,
                kind: "section",
                ...(indexChild ? { path: indexChild.path } : {}),
                children: children.filter((child) => child !== indexChild),
            });
            continue;
        }

        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
            continue;
        }

        const markdown = await readFile(join(rootDir, relPath), "utf8");
        const fallback = titleFromFolderName(
            stripNumericPrefix(entry.name.replace(/\.md$/i, "")),
        );
        nodes.push({
            id: pageIdFromRelativePath(relPath),
            title: titleFromMarkdown(markdown, fallback),
            kind: "page",
            path: relPath,
        });
    }

    return nodes;
}

/**
 * @param {object[]} nodes
 * @returns {string | null}
 */
function firstPageId(nodes) {
    for (const node of nodes) {
        if (node.kind === "page") {
            return node.id;
        }
        if (Array.isArray(node.children)) {
            const nested = firstPageId(node.children);
            if (nested) {
                return nested;
            }
        }
    }
    return null;
}

/**
 * @param {string} [rootDir]
 */
export async function buildManifest(rootDir = DOCUMENTATION_ROOT) {
    const nodes = await collectNodes(rootDir, "");
    return {
        version: 1,
        defaultId: firstPageId(nodes) || "",
        nodes,
    };
}

/**
 * @param {string} [rootDir]
 */
export async function writeManifest(rootDir = DOCUMENTATION_ROOT) {
    const manifest = await buildManifest(rootDir);
    const outputPath = join(rootDir, "manifest.json");
    const contents = `${JSON.stringify(manifest, null, 4)}\n`;
    try {
        const existing = await readFile(outputPath, "utf8");
        if (existing === contents) {
            return { manifest, outputPath, wrote: false };
        }
    } catch {
        // Manifest is missing or unreadable; write a fresh copy.
    }
    await writeFile(outputPath, contents);
    return { manifest, outputPath, wrote: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    writeManifest()
        .then(({ outputPath, manifest, wrote }) => {
            if (!wrote) {
                return;
            }
            console.log(
                `Wrote ${outputPath} (${manifest.nodes.length} top-level nodes)`,
            );
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
