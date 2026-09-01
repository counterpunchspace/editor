const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const MODEL_SOURCE_PATH = path.join(
    __dirname,
    '..',
    'js',
    'babelfont-model.ts'
);

// These normalize legacy serialized data on a read path; they are not supported
// editing APIs. Every other backing-data write must be guarded at its write site.
const INTERNAL_WRITE_EXCEPTIONS = new Map([
    [
        'Path.getMutableNodeArray',
        'Decodes legacy serialized nodes into their runtime representation.'
    ],
    [
        'ModelBase.constructor',
        'Initializes a wrapper reference; it does not edit existing font data.'
    ],
    [
        'Glyph.id',
        'Stamps an immutable glyph identity on first read of unstamped JSON.'
    ]
]);

const MUTATING_COLLECTION_METHODS = new Set([
    'add',
    'clear',
    'copyWithin',
    'delete',
    'fill',
    'pop',
    'push',
    'reverse',
    'set',
    'shift',
    'sort',
    'splice',
    'unshift'
]);

const BRIDGE_MUTATOR_NAMES = new Set([
    'applyLocalGeneratedYjsUpdate',
    'applySyntheticChangeSet'
]);

const OBJECT_MUTATOR_NAMES = new Set([
    'assign',
    'defineProperty',
    'setPrototypeOf'
]);

const REFLECT_MUTATOR_NAMES = new Set(['set', 'deleteProperty']);

function unwrapExpression(expression) {
    let current = expression;
    while (
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function getExpressionRoot(expression) {
    let current = unwrapExpression(expression);
    while (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    ) {
        current = unwrapExpression(current.expression);
    }
    return current;
}

function isThisModelStorage(expression) {
    let current = unwrapExpression(expression);
    while (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    ) {
        if (
            ts.isPropertyAccessExpression(current) &&
            ts.isThis(current.expression) &&
            (current.name.text === 'data' || current.name.text === '_data')
        ) {
            return true;
        }
        current = unwrapExpression(current.expression);
    }
    return false;
}

function isLiveJsonExpression(expression) {
    const current = unwrapExpression(expression);
    return (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === 'toJSON'
    );
}

function isGuardCall(node) {
    return (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'assertModelMutationAllowed'
    );
}

function isDirectGuardStatement(statement) {
    return (
        ts.isExpressionStatement(statement) && isGuardCall(statement.expression)
    );
}

function collectBindingNames(name, names) {
    if (ts.isIdentifier(name)) {
        names.push(name.text);
        return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
            if (ts.isBindingElement(element)) {
                collectBindingNames(element.name, names);
            }
        }
    }
}

function isFunctionLike(node) {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
    );
}

function getClassName(node) {
    let current = node.parent;
    while (current) {
        if (ts.isClassDeclaration(current) && current.name) {
            return current.name.text;
        }
        current = current.parent;
    }
    return null;
}

function getScopeLocalName(node, sourceFile) {
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if (
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
    ) {
        return node.name ? node.name.getText(sourceFile) : '<anonymous>';
    }
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    if (
        node.parent &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
    ) {
        return node.parent.name.text;
    }
    return `callback@${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
}

function collectScopes(sourceFile) {
    const scopes = [];

    function visit(node, parentScope = null) {
        let nextParentScope = parentScope;
        if (isFunctionLike(node) && node.body) {
            const localName = getScopeLocalName(node, sourceFile);
            const className = getClassName(node);
            const prefix = parentScope
                ? `${parentScope.qualifiedName}::`
                : className &&
                    (ts.isMethodDeclaration(node) ||
                        ts.isGetAccessorDeclaration(node) ||
                        ts.isSetAccessorDeclaration(node) ||
                        ts.isConstructorDeclaration(node))
                  ? `${className}.`
                  : '';
            nextParentScope = {
                node,
                body: node.body,
                qualifiedName: `${prefix}${localName}`,
                isSetter: ts.isSetAccessorDeclaration(node),
                parameterAliases: new Set(),
                aliases: new Set(),
                mutatorAliases: new Map()
            };
            scopes.push(nextParentScope);
        }
        ts.forEachChild(node, (child) => visit(child, nextParentScope));
    }

    visit(sourceFile);
    return scopes;
}

function visitScopeBody(scope, callback) {
    function visit(node) {
        if (node !== scope.node && isFunctionLike(node)) return;
        callback(node);
        ts.forEachChild(node, visit);
    }
    ts.forEachChild(scope.body, visit);
}

function isStorageExpression(expression, aliases) {
    const current = unwrapExpression(expression);
    const root = getExpressionRoot(current);
    return (
        isThisModelStorage(current) ||
        isLiveJsonExpression(current) ||
        (ts.isIdentifier(root) && aliases.has(root.text))
    );
}

function isStorageWriteTarget(expression, aliases) {
    const current = unwrapExpression(expression);
    return (
        isThisModelStorage(current) ||
        ((ts.isPropertyAccessExpression(current) ||
            ts.isElementAccessExpression(current)) &&
            isStorageExpression(current, aliases))
    );
}

function populateAliases(scope) {
    const aliases = scope.aliases;
    for (const parameterName of scope.parameterAliases) {
        aliases.add(parameterName);
    }

    let changed = true;
    while (changed) {
        changed = false;
        visitScopeBody(scope, (node) => {
            if (
                ts.isVariableDeclaration(node) &&
                node.initializer &&
                isStorageExpression(node.initializer, aliases)
            ) {
                const names = [];
                collectBindingNames(node.name, names);
                for (const name of names) {
                    if (!aliases.has(name)) {
                        aliases.add(name);
                        changed = true;
                    }
                }
            }
            if (
                ts.isBinaryExpression(node) &&
                ts.isAssignmentOperator(node.operatorToken.kind) &&
                ts.isIdentifier(node.left) &&
                isStorageExpression(node.right, aliases) &&
                !aliases.has(node.left.text)
            ) {
                aliases.add(node.left.text);
                changed = true;
            }
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                ts.isPropertyAccessExpression(
                    unwrapExpression(node.initializer)
                )
            ) {
                const initializer = unwrapExpression(node.initializer);
                const receiver = initializer.expression;
                const method = initializer.name.text;
                const utility =
                    ts.isIdentifier(receiver) &&
                    receiver.text === 'Object' &&
                    OBJECT_MUTATOR_NAMES.has(method)
                        ? 'Object'
                        : ts.isIdentifier(receiver) &&
                            receiver.text === 'Reflect' &&
                            REFLECT_MUTATOR_NAMES.has(method)
                          ? 'Reflect'
                          : null;
                if (utility && !scope.mutatorAliases.has(node.name.text)) {
                    scope.mutatorAliases.set(node.name.text, utility);
                    changed = true;
                }
            }
        });
    }
}

function populateParameterAliases(scopes) {
    const scopesByName = new Map();
    for (const scope of scopes) {
        const localName = scope.qualifiedName.split('::').pop();
        if (!scopesByName.has(localName)) scopesByName.set(localName, []);
        scopesByName.get(localName).push(scope);
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const scope of scopes) {
            populateAliases(scope);
            visitScopeBody(scope, (node) => {
                if (
                    !ts.isCallExpression(node) ||
                    !ts.isIdentifier(node.expression)
                ) {
                    return;
                }
                for (const target of scopesByName.get(node.expression.text) ||
                    []) {
                    node.arguments.forEach((argument, index) => {
                        if (!isStorageExpression(argument, scope.aliases))
                            return;
                        const parameter = target.node.parameters[index];
                        if (!parameter) return;
                        const names = [];
                        collectBindingNames(parameter.name, names);
                        for (const name of names) {
                            if (!target.parameterAliases.has(name)) {
                                target.parameterAliases.add(name);
                                changed = true;
                            }
                        }
                    });
                }
            });
        }
    }
}

function isProxyTrap(scope) {
    if (
        !(
            ts.isMethodDeclaration(scope.node) ||
            ts.isSetAccessorDeclaration(scope.node)
        ) ||
        !scope.node.name ||
        !['set', 'deleteProperty'].includes(scope.node.name.getText())
    ) {
        return false;
    }
    let current = scope.node.parent;
    while (current) {
        if (
            ts.isNewExpression(current) &&
            current.expression.getText() === 'Proxy'
        ) {
            return true;
        }
        if (isFunctionLike(current)) return false;
        current = current.parent;
    }
    return false;
}

function isMutationSink(node, scope) {
    const aliases = scope.aliases;
    if (
        ts.isBinaryExpression(node) &&
        ts.isAssignmentOperator(node.operatorToken.kind) &&
        isStorageWriteTarget(node.left, aliases)
    ) {
        return true;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        return (
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
                node.operator === ts.SyntaxKind.MinusMinusToken) &&
            isStorageWriteTarget(node.operand, aliases)
        );
    }
    if (ts.isDeleteExpression(node)) {
        return isStorageWriteTarget(node.expression, aliases);
    }
    if (!ts.isCallExpression(node)) return false;

    const expression = node.expression;
    const method = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isIdentifier(expression)
          ? expression.text
          : null;
    if (method && BRIDGE_MUTATOR_NAMES.has(method)) return true;
    const aliasedUtility =
        ts.isIdentifier(expression) &&
        scope.mutatorAliases.get(expression.text);
    if (aliasedUtility) {
        return (
            (aliasedUtility === 'Reflect' && isProxyTrap(scope)) ||
            node.arguments.some((argument) =>
                isStorageExpression(argument, aliases)
            )
        );
    }
    if (!ts.isPropertyAccessExpression(expression)) return false;

    const receiver = expression.expression;
    if (
        MUTATING_COLLECTION_METHODS.has(expression.name.text) &&
        isStorageExpression(receiver, aliases)
    ) {
        return true;
    }
    if (
        ts.isIdentifier(receiver) &&
        receiver.text === 'Object' &&
        OBJECT_MUTATOR_NAMES.has(method)
    ) {
        return node.arguments.some((argument) =>
            isStorageExpression(argument, aliases)
        );
    }
    if (
        ts.isIdentifier(receiver) &&
        receiver.text === 'Reflect' &&
        REFLECT_MUTATOR_NAMES.has(method)
    ) {
        return (
            isProxyTrap(scope) ||
            node.arguments.some((argument) =>
                isStorageExpression(argument, aliases)
            )
        );
    }
    return false;
}

function hasDominatingGuard(node, scope) {
    let current = node;
    while (current && current !== scope.body) {
        const parent = current.parent;
        if (parent && (ts.isBlock(parent) || ts.isSourceFile(parent))) {
            const statements = parent.statements;
            const index = statements.indexOf(current);
            if (
                index >= 0 &&
                statements.slice(0, index).some(isDirectGuardStatement)
            ) {
                return true;
            }
        }
        current = parent;
    }
    return false;
}

function hasEntryGuard(scope) {
    return (
        ts.isBlock(scope.body) &&
        scope.body.statements.length > 0 &&
        isDirectGuardStatement(scope.body.statements[0])
    );
}

function collectUnguardedModelMutatorSites(sourceFile) {
    const scopes = collectScopes(sourceFile);
    populateParameterAliases(scopes);
    const violations = [];

    for (const scope of scopes) {
        if (INTERNAL_WRITE_EXCEPTIONS.has(scope.qualifiedName)) continue;
        if (scope.isSetter && !hasEntryGuard(scope)) {
            violations.push(`${scope.qualifiedName} (setter)`);
        }
        visitScopeBody(scope, (node) => {
            if (
                !isMutationSink(node, scope) ||
                hasDominatingGuard(node, scope)
            ) {
                return;
            }
            const line =
                sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                ).line + 1;
            violations.push(`${scope.qualifiedName}@${line}`);
        });
    }

    return [...new Set(violations)].sort();
}

describe('object-model mutation guard contract', () => {
    test('rejects unguarded sinks in aliases, nested callbacks, setters, and proxies', () => {
        const sourceFile = ts.createSourceFile(
            'fixture.ts',
            `
                function writeThroughParameter(data) {
                    data.value = 1;
                }
                class Sample {
                    data = {};
                    set value(value) { this.data.value = value; }
                    aliases() {
                        const alias = this.toJSON();
                        writeThroughParameter(alias);
                    }
                    reflectAlias() {
                        const alias = this.data;
                        const write = Reflect.set;
                        write(alias, 'value', 1);
                    }
                    objectAlias() {
                        const alias = this.data;
                        const assign = Object.assign;
                        assign(alias, { value: 1 });
                    }
                    nested() {
                        const write = () => { this.data.value = 1; };
                        write();
                    }
                    lateGuard() {
                        this.data.value = 1;
                        assertModelMutationAllowed();
                    }
                    conditionalGuard(enabled) {
                        if (enabled) assertModelMutationAllowed();
                        this.data.value = 1;
                    }
                    proxy() {
                        return new Proxy({}, {
                            set(target, key, value) {
                                return Reflect.set(target, key, value);
                            }
                        });
                    }
                }
            `,
            ts.ScriptTarget.Latest,
            true
        );

        expect(collectUnguardedModelMutatorSites(sourceFile)).toEqual(
            expect.arrayContaining([
                'Sample.value (setter)',
                expect.stringMatching(/^Sample\.value@/),
                expect.stringMatching(/^Sample\.nested::write@/),
                expect.stringMatching(/^Sample\.reflectAlias@/),
                expect.stringMatching(/^Sample\.objectAlias@/),
                expect.stringMatching(/^Sample\.lateGuard@/),
                expect.stringMatching(/^Sample\.conditionalGuard@/),
                expect.stringMatching(/^Sample\.proxy::set@/),
                expect.stringMatching(/^writeThroughParameter@/)
            ])
        );
    });

    test('accepts guards that precede every sink in its executable scope', () => {
        const sourceFile = ts.createSourceFile(
            'guarded-fixture.ts',
            `
                class Sample {
                    data = {};
                    set value(value) {
                        assertModelMutationAllowed();
                        this.data.value = value;
                    }
                    nested() {
                        const write = () => {
                            assertModelMutationAllowed();
                            this.data.value = 1;
                        };
                        write();
                    }
                    proxy() {
                        return new Proxy({}, {
                            set(target, key, value) {
                                assertModelMutationAllowed();
                                return Reflect.set(target, key, value);
                            }
                        });
                    }
                }
            `,
            ts.ScriptTarget.Latest,
            true
        );

        expect(collectUnguardedModelMutatorSites(sourceFile)).toEqual([]);
    });

    test('requires the Assistant mutation guard in every model mutation boundary', () => {
        const source = fs.readFileSync(MODEL_SOURCE_PATH, 'utf8');
        const sourceFile = ts.createSourceFile(
            MODEL_SOURCE_PATH,
            source,
            ts.ScriptTarget.Latest,
            true
        );

        expect(collectUnguardedModelMutatorSites(sourceFile)).toEqual([]);
    });
});
