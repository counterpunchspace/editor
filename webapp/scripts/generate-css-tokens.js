/**
 * Generates CSS custom properties from Penpot/Design Tokens JSON
 * Run: node scripts/generate-css-tokens.js
 */

const fs = require('fs');
const path = require('path');

const tokensPath = path.join(__dirname, '../css/tokens.json');
const outputPath = path.join(__dirname, '../css/tokens.css');

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

/**
 * Convert camelCase to kebab-case
 */
function toKebabCase(str) {
    return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Recursively flatten tokens object into CSS variable declarations
 */
function flattenTokens(obj, prefix = '') {
    let vars = [];
    for (const [key, value] of Object.entries(obj)) {
        const kebabKey = toKebabCase(key);
        const name = prefix ? `${prefix}-${kebabKey}` : kebabKey;

        if (value && typeof value === 'object' && '$value' in value) {
            // This is a token leaf node
            let cssValue = value.$value;

            // Handle font family arrays
            if (Array.isArray(cssValue)) {
                cssValue = cssValue.map((v) => `'${v}'`).join(', ');
            }

            // Add units to numeric values based on type
            if (typeof cssValue === 'string' && /^\d+$/.test(cssValue)) {
                const type = value.$type;
                if (
                    type === 'fontSizes' ||
                    type === 'spacing' ||
                    type === 'borderRadius'
                ) {
                    cssValue = `${cssValue}px`;
                }
            }

            vars.push({ name: `--${name}`, value: cssValue });
        } else if (value && typeof value === 'object') {
            // Recurse into nested objects
            vars.push(...flattenTokens(value, name));
        }
    }
    return vars;
}

/**
 * Format CSS variable declarations
 */
function formatVars(vars) {
    return vars
        .map((v) => {
            return `    ${v.name}: ${v.value};`;
        })
        .join('\n');
}

// Generate CSS
const globalVars = flattenTokens(tokens.global);
const darkColorVars = flattenTokens(tokens.dark?.colors || {});
const lightColorVars = flattenTokens(tokens.light?.colors || {});

const css = `/* Auto-generated from tokens.json - DO NOT EDIT MANUALLY */
/* Run: node scripts/generate-css-tokens.js */

/* Global tokens (theme-independent) */
:root {
${formatVars(globalVars)}
}

/* Dark theme (default) */
:root {
${formatVars(darkColorVars)}
}

/* Light theme */
:root[data-theme="light"] {
${formatVars(lightColorVars)}
}
`;

fs.writeFileSync(outputPath, css);
console.log(`Generated ${outputPath}`);
console.log(`  - ${globalVars.length} global tokens`);
console.log(`  - ${darkColorVars.length} dark theme tokens`);
console.log(`  - ${lightColorVars.length} light theme tokens`);
