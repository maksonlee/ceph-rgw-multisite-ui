import {getAuthHeaders, getUser} from './auth.js';
import {API_BASE} from './config.js';

/**
 * A generic API fetch helper.
 * @param {string} path - The API endpoint path.
 * @param {object} options - Fetch options.
 * @returns {Promise<any>} The JSON response.
 */
async function _fetchApi(path, options = {}) {
    if (!getUser()) {
        throw new Error('Please login first.');
    }
    const res = await fetch(API_BASE + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
            ...(options.headers || {}),
        },
    });
    if (!res.ok) {
        const t = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status} ${t}`);
    }
    return res.json();
}

export function loadZones() {
    return _fetchApi('/zones');
}

export function listObjects(zone, prefix) {
    // Listing should always be fresh, so we bypass the browser's HTTP cache.
    return _fetchApi(`/list?zone=${encodeURIComponent(zone)}&prefix=${encodeURIComponent(prefix)}`, {cache: 'no-cache'});
}

export function checkConsistency(key, currentZone) {
    // This endpoint is for checking the *current* state, so we should never use the browser cache.
    // The application-level cache in app.js will prevent excessive requests.
    return _fetchApi(`/consistency/check?key=${encodeURIComponent(key)}&currentZone=${encodeURIComponent(currentZone)}`, {cache: 'no-cache'});
}

export async function uploadFile(zone, key, file) {
    const presign = await _fetchApi('/presign/upload', {
        method: 'POST',
        body: JSON.stringify({zone, key, content_type: file.type || 'application/octet-stream'}),
    });

    const resp = await fetch(presign.url, {
        method: 'PUT',
        body: file,
        headers: {'Content-Type': file.type || 'application/octet-stream'}
    });
    if (!resp.ok) throw new Error(await resp.text());
}

export async function getDownloadUrl(zone, key, version_id = null) {
    const body = version_id ? {zone, key, version_id} : {zone, key};
    const {url} = await _fetchApi('/presign/download', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    return url;
}

export function deleteObject(zone, key) {
    return _fetchApi(`/objects/${encodeURIComponent(zone)}/${encodeURIComponent(key)}`, {method: 'DELETE'});
}