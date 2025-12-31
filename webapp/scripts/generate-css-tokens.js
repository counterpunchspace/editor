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
 * Map token names to existing CSS variable names for compatibility
 */
const tokenToCssVarMap = {
    // Background colors
    'background-primary': 'bg-primary',
    'background-secondary': 'bg-secondary',
    'background-tertiary': 'bg-tertiary',
    'background-hover': 'bg-hover',
    'background-loading': 'bg-loading',
    'background-editor-sidebar': 'bg-editor-sidebar',
    'background-custom-name-highlight': 'bg-custom-name-highlight',

    // Text colors
    'text-primary': 'text-primary',
    'text-secondary': 'text-secondary',
    'text-tertiary': 'text-tertiary',
    'text-muted': 'text-muted',
    'text-faint': 'text-faint',
    'text-subtle': 'text-subtle',

    // Border colors
    'border-primary': 'border-primary',
    'border-secondary': 'border-secondary',
    'border-tertiary': 'border-tertiary',
    'border-active': 'border-active',

    // Accent colors
    'accent-cyan': 'accent-cyan',
    'accent-magenta': 'accent-magenta',
    'accent-yellow': 'accent-yellow',
    'accent-green': 'accent-green',
    'accent-red': 'accent-red',
    'accent-purple': 'accent-purple',
    'accent-blue': 'accent-blue',
    'accent-orange': 'accent-orange',

    // View colors
    'view-fontinfo': 'view-fontinfo',
    'view-editor': 'view-editor',
    'view-files': 'view-files',
    'view-console': 'view-console',
    'view-scripts': 'view-scripts',
    'view-assistant': 'view-assistant',

    // Button colors
    'button-bg': 'button-bg',
    'button-border': 'button-border',
    'button-hover-bg': 'button-hover-bg',
    'button-text': 'button-text',

    // Input colors
    'input-bg': 'input-bg',
    'input-border': 'input-border',

    // Modal colors
    'modal-bg': 'modal-bg',
    'modal-overlay': 'modal-overlay',

    // Scrollbar colors
    'scrollbar-track': 'scrollbar-track',
    'scrollbar-thumb': 'scrollbar-thumb',
    'scrollbar-thumb-hover': 'scrollbar-thumb-hover',

    // AI colors
    'ai-user-bg': 'ai-user-bg',
    'ai-user-text': 'ai-user-text',
    'ai-assistant-bg': 'ai-assistant-bg',
    'ai-assistant-text': 'ai-assistant-text',
    'ai-system-bg': 'ai-system-bg',
    'ai-error-bg': 'ai-error-bg',
    'ai-error-text': 'ai-error-text',

    // Code colors
    'code-bg': 'code-bg',

    // Autorun colors
    'autorun-disabled-border': 'autorun-disabled-border',
    'autorun-disabled-text': 'autorun-disabled-text',
    'autorun-active-bg': 'autorun-active-bg',
    'autorun-active-focused-bg': 'autorun-active-focused-bg',
    'autorun-active-text': 'autorun-active-text',

    // Font context colors
    'font-context-bg': 'font-context-bg',
    'font-context-focused-bg': 'font-context-focused-bg',
    'font-context-text': 'font-context-text',
    'font-context-focused-text': 'font-context-focused-text',

    // Script context colors
    'script-context-bg': 'script-context-bg',
    'script-context-focused-bg': 'script-context-focused-bg',
    'script-context-text': 'script-context-text',
    'script-context-focused-text': 'script-context-focused-text',

    // Custom cursor
    'custom-cursor-color': 'custom-cursor-color',

    // Typography
    'font-families-mono': 'font-mono',
    'font-families-sans': 'font-sans'
};

/**
 * Format CSS variable declarations
 */
function formatVars(vars) {
    return vars
        .map((v) => {
            const mappedName = tokenToCssVarMap[v.name.replace('--', '')];
            const finalName = mappedName ? `--${mappedName}` : v.name;
            return `    ${finalName}: ${v.value};`;
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
