/**
 * Playwright/console diagnostics for cloud collab P0.
 * Read from tests via `window.__collabIntegrity.snapshot('a')`.
 */

export type CollabIntegrityEvent = {
    at: number;
    type: string;
    [key: string]: unknown;
};

const MAX_EVENTS = 80;
const events: CollabIntegrityEvent[] = [];

type IntegrityProvider = (glyphName?: string) => Record<string, unknown>;

let snapshotProvider: IntegrityProvider | null = null;

export function pushCollabIntegrityEvent(
    type: string,
    detail: Record<string, unknown> = {}
): void {
    events.push({ at: Date.now(), type, ...detail });
    if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
    }
}

export function getCollabIntegrityEvents(): CollabIntegrityEvent[] {
    return events.map((event) => ({ ...event }));
}

export function setCollabIntegritySnapshotProvider(
    provider: IntegrityProvider | null
): void {
    snapshotProvider = provider;
    installCollabIntegrityWindowApi();
}

function installCollabIntegrityWindowApi(): void {
    const target = window as Window & {
        __collabIntegrity?: {
            snapshot: (glyphName?: string) => Record<string, unknown>;
            events: () => CollabIntegrityEvent[];
        };
    };
    target.__collabIntegrity = {
        snapshot: (glyphName?: string) => {
            const provided = snapshotProvider?.(glyphName) ?? {};
            return {
                ...provided,
                events: getCollabIntegrityEvents()
            };
        },
        events: () => getCollabIntegrityEvents()
    };
}

installCollabIntegrityWindowApi();
