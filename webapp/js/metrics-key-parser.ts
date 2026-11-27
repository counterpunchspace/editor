/**
 * Shared metrics-key grammar parser used by both live metrics-key evaluation
 * (`babelfont-model.ts`) and cloud sparse-hydration dependency indexing
 * (`filesystem-plugins/cloud-font-deps.ts`).
 */

export type ParsedMetricsKey =
    | {
          kind: 'constant';
          value: number;
          referencedGlyphNames: string[];
      }
    | {
          kind: 'automatic-offset';
          delta: number;
          referencedGlyphNames: string[];
      }
    | {
          kind: 'reference';
          glyphName: string | null;
          mirror: boolean;
          offsetY: number | null;
          operation: {
              operator: '+' | '-' | '*' | '/';
              value: number;
          } | null;
          referencedGlyphNames: string[];
      };

const METRICS_KEY_SUFFIX_OPERATORS = new Set(['@', '+', '-', '*', '/']);

export function isPlainNumericText(value: string): boolean {
    return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

export function matchGlyphNamePrefix(
    namesByLengthDesc: readonly string[],
    text: string
): { glyphName: string; rest: string } | null {
    for (const glyphName of namesByLengthDesc) {
        if (!glyphName) {
            continue;
        }
        if (text === glyphName) {
            return { glyphName, rest: '' };
        }
        const nextChar = text[glyphName.length];
        if (
            text.startsWith(glyphName) &&
            METRICS_KEY_SUFFIX_OPERATORS.has(nextChar)
        ) {
            return { glyphName, rest: text.slice(glyphName.length) };
        }
    }
    return null;
}

export function parseMetricsKeyText(
    rawKey: string,
    namesByLengthDesc: readonly string[]
): ParsedMetricsKey | { error: string } {
    let input = rawKey.trim();
    if (!input) {
        return { error: 'Empty metrics key' };
    }

    if (input.startsWith('==')) {
        input = input.slice(1);
    }

    if (isPlainNumericText(input)) {
        return {
            kind: 'constant',
            value: Number(input),
            referencedGlyphNames: []
        };
    }

    if (/^=\d+(?:\.\d+)?$/.test(input)) {
        return {
            kind: 'constant',
            value: Number(input.slice(1)),
            referencedGlyphNames: []
        };
    }

    if (/^=[+-]\d+(?:\.\d+)?$/.test(input)) {
        return {
            kind: 'automatic-offset',
            delta: Number(input.slice(1)),
            referencedGlyphNames: []
        };
    }

    let body = input.startsWith('=') ? input.slice(1) : input;
    let mirror = false;
    if (body.startsWith('|')) {
        mirror = true;
        body = body.slice(1);
    }

    if (!body) {
        return {
            kind: 'reference',
            glyphName: null,
            mirror,
            offsetY: null,
            operation: null,
            referencedGlyphNames: []
        };
    }

    const prefixMatch = matchGlyphNamePrefix(namesByLengthDesc, body);
    if (!prefixMatch) {
        return { error: `Unknown glyph reference in metrics key: ${rawKey}` };
    }

    let rest = prefixMatch.rest;
    let offsetY: number | null = null;
    let operation: { operator: '+' | '-' | '*' | '/'; value: number } | null =
        null;

    if (rest.startsWith('@')) {
        const offsetMatch = rest.match(/^@([+-]?\d+(?:\.\d+)?)(.*)$/);
        if (!offsetMatch) {
            return {
                error: `Invalid baseline offset in metrics key: ${rawKey}`
            };
        }
        offsetY = Number(offsetMatch[1]);
        rest = offsetMatch[2] || '';
    }

    if (rest) {
        const operationMatch = rest.match(/^([+\-*/])([+-]?\d+(?:\.\d+)?)$/);
        if (!operationMatch) {
            return {
                error: `Invalid calculation suffix in metrics key: ${rawKey}`
            };
        }
        operation = {
            operator: operationMatch[1] as '+' | '-' | '*' | '/',
            value: Number(operationMatch[2])
        };
    }

    return {
        kind: 'reference',
        glyphName: prefixMatch.glyphName,
        mirror,
        offsetY,
        operation,
        referencedGlyphNames: [prefixMatch.glyphName]
    };
}
