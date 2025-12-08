/**
 * Get the closing bracket character corresponding to a given opening bracket character.
 * @param {string} char
 * @returns {string | null}
 */
declare function closingToOpeningBracket(char: string): string | null;
/**
 * @param {string} char
 * @return {number}
 */
declare function getBidiCharType(char: string): number;
/**
 * Get Bidi Character Type Name
 * @param {string} char
 * @returns { "R" | "EN" | "ES" | "ET" | "AN" | "CS" | "B" | "S" | "WS" | "ON" | "BN" | "NSM" | "AL" | "LRO" | "RLO" | "LRE" | "RLE" | "PDF" | "LRI" | "RLI" | "FSI" | "PDI" }
 */
declare function getBidiCharTypeName(
    char: string
):
    | 'R'
    | 'EN'
    | 'ES'
    | 'ET'
    | 'AN'
    | 'CS'
    | 'B'
    | 'S'
    | 'WS'
    | 'ON'
    | 'BN'
    | 'NSM'
    | 'AL'
    | 'LRO'
    | 'RLO'
    | 'LRE'
    | 'RLE'
    | 'PDF'
    | 'LRI'
    | 'RLI'
    | 'FSI'
    | 'PDI';
/**
 * Retrieves the canonical form of a bracket character.
 * @param {string} char
 * @returns {string | null}
 */
declare function getCanonicalBracket(char: string): string | null;
/**
 * @typedef {object} GetEmbeddingLevelsResult
 * @property {{start: number, end: number, level: number}[]} paragraphs
 * @property {Uint8Array} levels
 */
/**
 * This function applies the Bidirectional Algorithm to a string, returning the resolved embedding levels
 * in a single Uint8Array plus a list of objects holding each paragraph's start and end indices and resolved
 * base embedding level.
 *
 * @param {string} string - The input string
 * @param {"ltr"|"rtl"|"auto"} [baseDirection] - Use "ltr" or "rtl" to force a base paragraph direction,
 *        otherwise a direction will be chosen automatically from each paragraph's contents.
 * @return {GetEmbeddingLevelsResult}
 */
declare function getEmbeddingLevels(
    string: string,
    baseDirection?: 'ltr' | 'rtl' | 'auto'
): {
    paragraphs: {
        start: number;
        end: number;
        level: number;
    }[];
    levels: Uint8Array;
};
/**
 * Get the mirrored character for a given character, if one exists.
 * @param {string} char
 * @return {string|null}
 */
declare function getMirroredCharacter(char: string): string | null;
/**
 * Given a string and its resolved embedding levels, build a map of indices to replacement chars
 * for any characters in right-to-left segments that have defined mirrored characters.
 * @param {string} string
 * @param {Uint8Array} embeddingLevels
 * @param {number?} [start]
 * @param {number?} [end]
 * @return {Map<number, string>}
 */
declare function getMirroredCharactersMap(
    string: string,
    embeddingLevels: Uint8Array,
    start?: number | null,
    end?: number | null
): Map<number, string>;
/**
 * Given a start and end denoting a single line within a string, and a set of precalculated
 * bidi embedding levels, produce a list of segments whose ordering should be flipped, in sequence.
 * @param {string} string - the full input string
 * @param {GetEmbeddingLevelsResult} embeddingLevelsResult - the result object from getEmbeddingLevels
 * @param {number} [start] - first character in a subset of the full string
 * @param {number} [end] - last character in a subset of the full string
 * @return {number[][]} - the list of start/end segments that should be flipped, in order.
 */
declare function getReorderSegments(
    string: string,
    embeddingLevelsResult: {
        paragraphs: {
            start: number;
            end: number;
            level: number;
        }[];
        levels: Uint8Array;
    },
    start?: number,
    end?: number
): number[][];
/**
 * @param {string} string
 * @param {GetEmbeddingLevelsResult} embedLevelsResult
 * @param {number} [start]
 * @param {number} [end]
 * @return {number[]} an array with character indices in their new bidi order
 */
declare function getReorderedIndices(
    string: string,
    embedLevelsResult: {
        paragraphs: {
            start: number;
            end: number;
            level: number;
        }[];
        levels: Uint8Array;
    },
    start?: number,
    end?: number
): number[];
/**
 * @param {string} string
 * @param {GetEmbeddingLevelsResult} embedLevelsResult
 * @param {number} [start]
 * @param {number} [end]
 * @return {string} the new string with bidi segments reordered
 */
declare function getReorderedString(
    string: string,
    embedLevelsResult: {
        paragraphs: {
            start: number;
            end: number;
            level: number;
        }[];
        levels: Uint8Array;
    },
    start?: number,
    end?: number
): string;
/**
 * Get the opening bracket character corresponding to a given closing bracket character.
 * @param {string} char
 * @returns {string | null}
 */
declare function openingToClosingBracket(char: string): string | null;

declare module 'bidi-js' {
    export default function bidiFactory(): {
        closingToOpeningBracket: typeof closingToOpeningBracket;
        getBidiCharType: typeof getBidiCharType;
        getBidiCharTypeName: typeof getBidiCharTypeName;
        getCanonicalBracket: typeof getCanonicalBracket;
        getEmbeddingLevels: typeof getEmbeddingLevels;
        getMirroredCharacter: typeof getMirroredCharacter;
        getMirroredCharactersMap: typeof getMirroredCharactersMap;
        getReorderSegments: typeof getReorderSegments;
        getReorderedIndices: typeof getReorderedIndices;
        getReorderedString: typeof getReorderedString;
        openingToClosingBracket: typeof openingToClosingBracket;
    };
}
