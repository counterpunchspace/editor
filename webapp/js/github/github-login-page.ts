// github-login.html: where the GitHub sign-in popup ends. It stores the
// login, tells the launcher and closes.

import { resolveWebsiteURL } from '../website-url';
import { finishGitHubSignIn } from './github-sign-in';
import { announceGitHubSignIn, saveGitHubCredential } from './github-session';

const message = document.getElementById('github-login-message') as HTMLElement;

// The code is good for one exchange; keep it out of the history.
const search = location.search;
history.replaceState(null, '', location.pathname);

void finishGitHubSignIn(search, (code) =>
    fetch(new URL('/api/github/oauth/exchange', resolveWebsiteURL()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        credentials: 'omit',
        cache: 'no-store'
    })
).then(async (result) => {
    if (!result.ok) {
        message.textContent = result.message;
        return;
    }
    await saveGitHubCredential(result.credential);
    announceGitHubSignIn();
    message.textContent = `Signed in to GitHub as ${result.credential.login}. You can close this window.`;
    window.close();
});
