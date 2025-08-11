import {UserManager, WebStorageStateStore} from 'https://cdn.jsdelivr.net/npm/oidc-client-ts@2.4.0/+esm';
import {OIDC_CONFIG} from './config.js';

export const um = new UserManager({
    ...OIDC_CONFIG,
    userStore: new WebStorageStateStore({store: window.localStorage}),
});
let currentUser = null;

/**
 * Handles the OIDC redirect and fetches the current user.
 * Should be called on application startup.
 * @returns {Promise<User|null>} The authenticated user object or null.
 */
export async function initAuth() {
    await handleRedirectIfAny();
    currentUser = await getCurrentUser();
    return currentUser;
}

/**
 * Proactively refreshes the authentication state, attempting a silent
 * token refresh if the current token is expired.
 * @returns {Promise<User|null>} The updated user object or null if refresh fails.
 */
export async function refreshAuth() {
    currentUser = await getCurrentUser();
    return currentUser;
}

/**
 * @returns {User|null} The current authenticated user.
 */
export function getUser() {
    return currentUser;
}

/**
 * @returns {object} The Authorization header for API requests.
 */
export function getAuthHeaders() {
    return currentUser ? {Authorization: 'Bearer ' + currentUser.access_token} : {};
}

/**
 * Initiates the OIDC login redirect flow.
 */
export function login() {
    return um.signinRedirect();
}

async function handleRedirectIfAny() {
    if (location.search.includes('code=') || location.search.includes('session_state=')) {
        await um.signinRedirectCallback();
        history.replaceState({}, document.title, location.pathname);
    }
}

async function getCurrentUser() {
    let user = await um.getUser();
    if (user && user.expired) {
        console.log("User token is expired, attempting silent renew...");
        try {
            // signinSilent will return a new user object with a fresh token.
            user = await um.signinSilent();
            console.log("Silent renew successful.");
        } catch (e) {
            console.error("Silent renew failed, user must login again.", e);
            // If silent renew fails, the user is effectively logged out.
            await um.removeUser();
            user = null;
        }
    }
    return user;
}