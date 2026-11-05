// A glyph filter's description is its Python module docstring.

/** Location of the module docstring literal inside the source. */
interface DocstringSpan {
    start: number;
    end: number;
    quote: '"""' | "'''" | '"' | "'";
    raw: boolean;
    body: string;
}

const CODING_OR_SHEBANG = /^(#!|#.*coding[:=])/;

/** Index of the first statement: skips blank lines and comments. */
function firstStatementIndex(code: string): number {
    let index = 0;
    while (index < code.length) {
        const lineEnd = code.indexOf('\n', index);
        const line = code.slice(index, lineEnd === -1 ? code.length : lineEnd);
        const trimmed = line.trim();
        if (trimmed !== '' && !trimmed.startsWith('#')) {
            return index + (line.length - line.trimStart().length);
        }
        if (lineEnd === -1) {
            return code.length;
        }
        index = lineEnd + 1;
    }
    return code.length;
}

function findDocstring(code: string): DocstringSpan | null {
    const start = firstStatementIndex(code);
    const prefixMatch = /^([rRuU]?)("""|'''|"|')/.exec(code.slice(start));
    if (!prefixMatch) {
        return null;
    }
    const raw = prefixMatch[1].toLowerCase() === 'r';
    const quote = prefixMatch[2] as DocstringSpan['quote'];
    const bodyStart = start + prefixMatch[0].length;
    const triple = quote.length === 3;
    let index = bodyStart;
    while (index < code.length) {
        const char = code[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (!triple && char === '\n') {
            return null;
        }
        if (code.startsWith(quote, index)) {
            const end = index + quote.length;
            // A docstring is a statement of its own, not `"x".upper()`.
            const lineEnd = code.indexOf('\n', end);
            const rest = code.slice(end, lineEnd === -1 ? undefined : lineEnd);
            if (!/^\s*(#.*)?$/.test(rest) && !/^\s*;/.test(rest)) {
                return null;
            }
            return {
                start,
                end,
                quote,
                raw,
                body: code.slice(bodyStart, index)
            };
        }
        index += 1;
    }
    return null;
}

const SIMPLE_ESCAPES: Record<string, string> = {
    '\\': '\\',
    "'": "'",
    '"': '"',
    'n': '\n',
    't': '\t',
    'r': '\r',
    '\n': ''
};

function unescapePython(body: string): string {
    return body.replace(/\\(.|\n)/g, (match, char: string) =>
        char in SIMPLE_ESCAPES ? SIMPLE_ESCAPES[char] : match
    );
}

/** Python's `inspect.cleandoc`, without tab expansion. */
function cleandoc(text: string): string {
    const lines = text.split('\n');
    let margin = Infinity;
    for (const line of lines.slice(1)) {
        const content = line.trimStart();
        if (content) {
            margin = Math.min(margin, line.length - content.length);
        }
    }
    const cleaned = [lines[0].trimStart()];
    for (const line of lines.slice(1)) {
        cleaned.push(Number.isFinite(margin) ? line.slice(margin) : line);
    }
    while (cleaned.length && !cleaned[0].trim()) {
        cleaned.shift();
    }
    while (cleaned.length && !cleaned[cleaned.length - 1].trim()) {
        cleaned.pop();
    }
    return cleaned.map((line) => line.trimEnd()).join('\n');
}

/** The filter's description: its module docstring, cleaned. '' when none. */
export function readFilterDescription(code: string): string {
    const docstring = findDocstring(code);
    if (!docstring) {
        return '';
    }
    const body = docstring.raw
        ? docstring.body
        : unescapePython(docstring.body);
    return cleandoc(body);
}

function docstringLiteral(text: string, quote: '"""' | "'''"): string {
    const cleaned = text.replace(/\r\n?/g, '\n').trim();
    if (!cleaned) {
        return `${quote}\n${quote}`;
    }
    const quoteChar = quote[0];
    const escaped = cleaned
        .replace(/\\/g, '\\\\')
        .split(quote)
        .join(`\\${quoteChar}\\${quoteChar}\\${quoteChar}`);
    return `${quote}\n${escaped}\n${quote}`;
}

/**
 * Replace the module docstring with `text`, or add one at the top of the
 * file (after a shebang or coding line). Everything else is kept as is.
 */
export function writeFilterDescription(code: string, text: string): string {
    const docstring = findDocstring(code);
    if (docstring) {
        const quote = docstring.quote === "'''" ? "'''" : '"""';
        return (
            code.slice(0, docstring.start) +
            docstringLiteral(text, quote) +
            code.slice(docstring.end)
        );
    }
    let insertAt = 0;
    const lines = code.split('\n');
    for (let index = 0; index < Math.min(2, lines.length); index += 1) {
        if (!CODING_OR_SHEBANG.test(lines[index])) {
            break;
        }
        insertAt += lines[index].length + 1;
    }
    insertAt = Math.min(insertAt, code.length);
    const before = code.slice(0, insertAt);
    const separator = before && !before.endsWith('\n') ? '\n' : '';
    return `${before}${separator}${docstringLiteral(text, '"""')}\n${code.slice(insertAt)}`;
}
