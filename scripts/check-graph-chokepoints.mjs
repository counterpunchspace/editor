import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const configurationPath = fileURLToPath(
    new URL("../architecture/graph-chokepoints.json", import.meta.url),
);

/** Parse the GitNexus CLI's compact markdown table into caller identities. */
export function parseCallerRows(markdown) {
    const lines = markdown.split("\n").filter((line) => line.startsWith("|"));
    if (lines.length < 2) {
        return [];
    }

    const headers = lines[0]
        .split("|")
        .slice(1, -1)
        .map((value) => value.trim());
    return lines.slice(2).map((line) => {
        const values = line
            .split("|")
            .slice(1, -1)
            .map((value) => value.trim());
        return Object.fromEntries(
            headers.map((header, index) => [header, values[index] ?? ""]),
        );
    });
}

/** Run one graph query and return its production caller identities. */
export function queryCallers(query) {
    let output;
    try {
        output = execFileSync(
            "npx",
            ["--no-install", "gitnexus", "cypher", query],
            {
                cwd: repositoryRoot,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
    } catch (error) {
        const detail = error.stderr?.toString().trim() || error.message;
        throw new Error(`GitNexus query failed: ${detail}`);
    }

    let response;
    try {
        response = JSON.parse(output);
    } catch (error) {
        throw new Error(
            `GitNexus returned non-JSON output: ${error.message}\n${output}`,
        );
    }

    if (Array.isArray(response)) {
        return [];
    }
    if (typeof response.markdown !== "string") {
        throw new Error("GitNexus response did not include a markdown result");
    }

    return parseCallerRows(response.markdown)
        .map((row) => `${row.caller_path}::${row.caller_name}`)
        .sort();
}

/** Compare each protected chokepoint's actual callers to its reviewed baseline. */
export function checkRule(rule, getCallers = queryCallers) {
    const actual = getCallers(rule.query);
    const expected = [...rule.allowedCallers].sort();
    const unexpected = actual.filter((caller) => !expected.includes(caller));
    const missing = expected.filter((caller) => !actual.includes(caller));

    if (unexpected.length === 0 && missing.length === 0) {
        console.log(`PASS ${rule.id}`);
        return;
    }

    const details = [
        `Graph chokepoint guard failed: ${rule.id}`,
        rule.description,
        ...(unexpected.length
            ? [
                  `Unexpected callers:\n${unexpected.map((value) => `  + ${value}`).join("\n")}`,
              ]
            : []),
        ...(missing.length
            ? [
                  `Missing reviewed callers:\n${missing.map((value) => `  - ${value}`).join("\n")}`,
              ]
            : []),
        "Update the implementation to use the protected funnel, or deliberately review and update architecture/graph-chokepoints.json.",
    ];
    throw new Error(details.join("\n"));
}

function getNodeName(node) {
    return ts.isIdentifier(node) || ts.isStringLiteral(node)
        ? node.text
        : "<anonymous>";
}

function getEnclosingSymbol(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isMethodDeclaration(current)) {
            const classDeclaration = current.parent;
            if (
                ts.isClassDeclaration(classDeclaration) &&
                classDeclaration.name
            ) {
                return `${classDeclaration.name.text}.${getNodeName(current.name)}`;
            }
        }
        if (ts.isFunctionDeclaration(current) && current.name) {
            return current.name.text;
        }
    }
    return "<module>";
}

function isTypeProperty(node) {
    return (
        (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node)) &&
        getNodeName(node.name) === "type"
    );
}

function getLiteralMessageTypes(node, messageTypes, bindings) {
    if (ts.isStringLiteral(node)) {
        return messageTypes.includes(node.text) ? [node.text] : [];
    }
    if (ts.isIdentifier(node)) {
        return bindings.get(node.text) ?? [];
    }
    return [];
}

function getObjectMessageTypes(node, messageTypes, bindings) {
    if (!ts.isObjectLiteralExpression(node)) {
        return [];
    }

    return node.properties.flatMap((property) => {
        if (!isTypeProperty(property)) {
            return [];
        }
        return getLiteralMessageTypes(
            ts.isShorthandPropertyAssignment(property)
                ? property.name
                : property.initializer,
            messageTypes,
            bindings,
        );
    });
}

/** Find full-document worker request objects, including literal-backed type variables. */
export function findWorkerMessageSites(sourceText, filePath, messageTypes) {
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const typeBindings = new Map();
    const requestBindings = new Map();
    const sites = [];

    const visit = (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer
        ) {
            const types = getLiteralMessageTypes(
                node.initializer,
                messageTypes,
                typeBindings,
            );
            if (types.length) {
                typeBindings.set(node.name.text, types);
            }

            const requestTypes = getObjectMessageTypes(
                node.initializer,
                messageTypes,
                typeBindings,
            );
            if (requestTypes.length) {
                requestBindings.set(node.name.text, requestTypes);
            }
        }

        if (ts.isCallExpression(node)) {
            for (const argument of node.arguments) {
                const messageTypesAtSite = ts.isIdentifier(argument)
                    ? (requestBindings.get(argument.text) ?? [])
                    : getObjectMessageTypes(
                          argument,
                          messageTypes,
                          typeBindings,
                      );
                for (const messageType of messageTypesAtSite) {
                    sites.push(
                        `${filePath}::${getEnclosingSymbol(node)}::${messageType}`,
                    );
                }
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return [...new Set(sites)].sort();
}

function collectSourceFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectSourceFiles(entryPath);
        }
        return entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)
            ? [entryPath]
            : [];
    });
}

/** Find full-document worker requests in the checked-in production sources. */
export function queryWorkerMessageSites(rule) {
    return collectSourceFiles(join(repositoryRoot, rule.path))
        .filter(
            (filePath) =>
                !rule.excludedPaths?.includes(
                    relative(repositoryRoot, filePath),
                ),
        )
        .flatMap((filePath) =>
            findWorkerMessageSites(
                readFileSync(filePath, "utf8"),
                relative(repositoryRoot, filePath),
                rule.messageTypes,
            ),
        )
        .sort();
}

function getCalleeName(expression) {
    if (ts.isIdentifier(expression)) {
        return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
        return getNodeName(expression.name);
    }
    return null;
}

/** Find production call sites of a named function or method. */
export function findIdentifierCallSites(sourceText, filePath, identifier) {
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const sites = [];

    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const calleeName = getCalleeName(node.expression);
            if (calleeName === identifier) {
                sites.push(`${filePath}::${getEnclosingSymbol(node)}`);
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return [...new Set(sites)].sort();
}

function symbolMatchesNode(node, symbol) {
    if (ts.isFunctionDeclaration(node) && node.name) {
        return node.name.text === symbol;
    }
    if (
        ts.isMethodDeclaration(node) &&
        ts.isClassDeclaration(node.parent) &&
        node.parent.name
    ) {
        return `${node.parent.name.text}.${getNodeName(node.name)}` === symbol;
    }
    return false;
}

function collectCalleeNames(node, names) {
    if (ts.isCallExpression(node)) {
        const calleeName = getCalleeName(node.expression);
        if (calleeName) {
            names.add(calleeName);
        }
    }
    ts.forEachChild(node, (child) => collectCalleeNames(child, names));
}

/** Return required identifiers missing from a named function or method body. */
export function findMissingRequiredCalls(
    sourceText,
    filePath,
    symbol,
    requiredNames,
) {
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    let target = null;
    const visit = (node) => {
        if (symbolMatchesNode(node, symbol)) {
            target = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!target) {
        throw new Error(
            `Required-call symbol ${symbol} not found in ${filePath}`,
        );
    }
    const found = new Set();
    collectCalleeNames(target, found);
    return requiredNames.filter((name) => !found.has(name));
}

/** Find identifier call sites in the checked-in production sources. */
export function queryIdentifierCallSites(rule) {
    return collectSourceFiles(join(repositoryRoot, rule.path))
        .filter(
            (filePath) =>
                !rule.excludedPaths?.includes(
                    relative(repositoryRoot, filePath),
                ),
        )
        .flatMap((filePath) =>
            findIdentifierCallSites(
                readFileSync(filePath, "utf8"),
                relative(repositoryRoot, filePath),
                rule.identifier,
            ),
        )
        .sort();
}

/** Compare production identifier call sites to their reviewed locations. */
export function checkCallSiteRule(rule, getSites = queryIdentifierCallSites) {
    const actual = getSites(rule);
    const expected = [...rule.allowedSites].sort();
    const unexpected = actual.filter((site) => !expected.includes(site));
    const missing = expected.filter((site) => !actual.includes(site));

    if (unexpected.length === 0 && missing.length === 0) {
        console.log(`PASS ${rule.id}`);
        return;
    }

    const details = [
        `Call-site chokepoint guard failed: ${rule.id}`,
        rule.description,
        ...(unexpected.length
            ? [
                  `Unexpected ${rule.identifier} calls:\n${unexpected.map((value) => `  + ${value}`).join("\n")}`,
              ]
            : []),
        ...(missing.length
            ? [
                  `Missing reviewed ${rule.identifier} calls:\n${missing.map((value) => `  - ${value}`).join("\n")}`,
              ]
            : []),
        "Keep compile-facing JSON off the resting write path, or deliberately review and update architecture/graph-chokepoints.json.",
    ];
    throw new Error(details.join("\n"));
}

/** Assert reviewed write sites still call the resting-layer codec. */
export function checkRequiredCallRule(rule) {
    const failures = [];
    for (const site of rule.sites) {
        const filePath = join(repositoryRoot, site.path);
        const missing = findMissingRequiredCalls(
            readFileSync(filePath, "utf8"),
            site.path,
            site.symbol,
            site.mustCall,
        );
        if (missing.length) {
            failures.push(
                `  ${site.path}::${site.symbol} missing ${missing.join(", ")}`,
            );
        }
    }

    if (failures.length === 0) {
        console.log(`PASS ${rule.id}`);
        return;
    }

    throw new Error(
        [
            `Required-call chokepoint guard failed: ${rule.id}`,
            rule.description,
            "Missing codec calls:",
            ...failures,
            "Route layer writes through resting-layer-json.ts, or deliberately review and update architecture/graph-chokepoints.json.",
        ].join("\n"),
    );
}

/** Compare full-document worker requests to their reviewed source locations. */
export function checkSourceRule(rule, getSites = queryWorkerMessageSites) {
    const actual = getSites(rule);
    const expected = [...rule.allowedSites].sort();
    const unexpected = actual.filter((site) => !expected.includes(site));
    const missing = expected.filter((site) => !actual.includes(site));

    if (unexpected.length === 0 && missing.length === 0) {
        console.log(`PASS ${rule.id}`);
        return;
    }

    const details = [
        `Source chokepoint guard failed: ${rule.id}`,
        rule.description,
        ...(unexpected.length
            ? [
                  `Unexpected full-document requests:\n${unexpected.map((value) => `  + ${value}`).join("\n")}`,
              ]
            : []),
        ...(missing.length
            ? [
                  `Missing reviewed requests:\n${missing.map((value) => `  - ${value}`).join("\n")}`,
              ]
            : []),
        "Route steady-state edits through incremental Yjs updates, or deliberately review and update architecture/graph-chokepoints.json.",
    ];
    throw new Error(details.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
    if (
        !Array.isArray(configuration.rules) ||
        configuration.rules.length === 0
    ) {
        throw new Error(
            "Graph chokepoint configuration must contain at least one rule",
        );
    }

    // Set by scripts/gitnexus-analyze.mjs when CI could not build the index
    // because LadybugDB's extension server was down.
    const indexUnavailable = existsSync(
        new URL("../.gitnexus-extension-outage", import.meta.url),
    );
    if (indexUnavailable) {
        console.log(
            "::warning::Skipping graph chokepoint queries: no GitNexus index (LadybugDB extension server outage).",
        );
    } else {
        for (const rule of configuration.rules) {
            checkRule(rule);
        }
    }
    for (const rule of configuration.sourceRules ?? []) {
        checkSourceRule(rule);
    }
    for (const rule of configuration.callSiteRules ?? []) {
        checkCallSiteRule(rule);
    }
    for (const rule of configuration.requiredCallRules ?? []) {
        checkRequiredCallRule(rule);
    }
}
