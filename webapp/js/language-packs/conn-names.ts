/** ``source.conn-<id>-<step>`` names. The id is whatever the user chose. */

const CONN_NAME = /^(?<source>.+)\.conn-(?<id>[A-Za-z0-9]+)-(?<step>[0-9]+)$/;

export interface ConnName {
    source: string;
    id: string;
    step: number;
}

export function parseConnName(name: string): ConnName | null {
    const match = CONN_NAME.exec(name);
    const source = match?.groups?.source;
    const id = match?.groups?.id;
    const step = match?.groups?.step;
    if (!source || !id || !step) {
        return null;
    }
    return { source, id, step: Number(step) };
}

export function connectionTarget(
    source: string,
    id: string,
    step: number
): string {
    return `${source}.conn-${id}-${step}`;
}
