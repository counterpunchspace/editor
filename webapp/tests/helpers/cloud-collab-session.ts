import { type BrowserContext, type APIRequestContext } from '@playwright/test';

export const LOCAL_WEBSITE_ORIGIN = 'https://localhost:8788';
export const LOCAL_EDITOR_ORIGIN = 'https://localhost:8000';
export const LOCAL_ROOM_ORIGIN = 'http://localhost:8787';

export type CloudCollabRole = 'owner' | 'invitee' | 'viewer';

export type CloudCollabUserSession = {
    role: CloudCollabRole;
    email: string;
    sessionToken: string;
    user: {
        id: string;
        email: string;
        name: string | null;
    };
};

function websiteUrl(): string {
    return process.env.CLOUD_COLLAB_WEBSITE_URL || LOCAL_WEBSITE_ORIGIN;
}

export function makeCloudCollabEmails(
    runId: string
): Record<CloudCollabRole, string> {
    return {
        owner: `e2e-${runId}-owner@counterpunch.test`,
        invitee: `e2e-${runId}-invitee@counterpunch.test`,
        viewer: `e2e-${runId}-viewer@counterpunch.test`
    };
}

export async function bootstrapCloudCollabSession(
    request: APIRequestContext,
    email: string,
    role: CloudCollabRole
): Promise<CloudCollabUserSession> {
    const response = await request.post(
        `${websiteUrl()}/api/dev/local-cloud-session`,
        {
            data: { email, name: `E2E ${role}` },
            headers: { Origin: LOCAL_EDITOR_ORIGIN },
            failOnStatusCode: false
        }
    );
    if (!response.ok()) {
        throw new Error(
            `local-cloud-session failed (${response.status()}): ${await response.text()}`
        );
    }
    const body = (await response.json()) as {
        sessionToken: string;
        user: CloudCollabUserSession['user'];
    };
    if (!body?.sessionToken || !body?.user?.id) {
        throw new Error(
            'local-cloud-session response missing sessionToken/user'
        );
    }
    return {
        role,
        email,
        sessionToken: body.sessionToken,
        user: body.user
    };
}

export async function attachCloudCollabCookies(
    context: BrowserContext,
    session: CloudCollabUserSession
): Promise<void> {
    await context.addCookies([
        {
            name: 'editor_session',
            value: session.sessionToken,
            url: LOCAL_EDITOR_ORIGIN,
            sameSite: 'Lax'
        },
        {
            name: 'session',
            value: session.sessionToken,
            url: websiteUrl(),
            sameSite: 'Lax'
        }
    ]);
}

export async function cleanupCloudCollabUsers(
    request: APIRequestContext,
    emails: string[]
): Promise<void> {
    if (!emails.length) {
        return;
    }
    const response = await request.post(
        `${websiteUrl()}/api/dev/local-cloud-cleanup`,
        {
            data: { emails },
            headers: { Origin: LOCAL_EDITOR_ORIGIN },
            failOnStatusCode: false
        }
    );
    if (!response.ok() && response.status() !== 404) {
        console.warn(
            `local-cloud-cleanup failed (${response.status()}): ${await response.text()}`
        );
    }
}
