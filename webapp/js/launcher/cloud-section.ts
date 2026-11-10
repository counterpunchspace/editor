// What the launcher's Cloud group shows.

export type CloudSectionInput = {
    /** The website confirmed the session. */
    signedIn: boolean;
    /** A session is stored but not confirmed yet (the page just loaded). */
    pending: boolean;
    /** A session is stored but the website couldn't be reached. */
    unreachable: boolean;
    /** A list of cloud fonts is known, fresh or from the last visit. */
    hasList: boolean;
    loading: boolean;
    failed: boolean;
};

export type CloudSection = {
    body: 'login' | 'list' | 'loading' | 'failed';
    /** Shown next to the group title. */
    status: string;
};

/**
 * A stored session counts as logged in until the website says otherwise, so
 * the log-in prompt never shows while the account is still loading. A known
 * list stays visible while it is refreshed.
 */
export function cloudSection(input: CloudSectionInput): CloudSection {
    if (!input.signedIn && !input.pending && !input.unreachable) {
        return { body: 'login', status: '' };
    }
    const failed = input.failed || input.unreachable;
    if (input.hasList) {
        return {
            body: 'list',
            status: input.loading
                ? 'Updating…'
                : failed
                  ? 'Couldn’t update'
                  : ''
        };
    }
    if (!input.loading && failed) return { body: 'failed', status: '' };
    return { body: 'loading', status: '' };
}
