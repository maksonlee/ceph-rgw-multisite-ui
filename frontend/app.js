// Frontend: Material style + manual login (OIDC only when clicking "Login")
// Features: folder navigation (click name), up one level (click text),
//           file click to download (consistency pre-check), replication badges (opt-in),
//           upload with custom file picker, caching, breadcrumb, auto-hide Login.
import {formatDate, formatSize, promisePool} from './js/utils.js';
import * as auth from './js/auth.js';
import * as api from './js/api.js';

// ====== UI refs ======
const loginBtn = document.getElementById('login');
const zoneSel = document.getElementById('zoneSelect');
const fileList = document.getElementById('fileList');
const fileInput = document.getElementById('fileInput');
const fileChosen = document.getElementById('fileChosen');
const uploadKey = document.getElementById('uploadKey');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const showStatus = document.getElementById('showStatus');
const breadcrumb = document.getElementById('breadcrumb');
const loginPrompt = document.getElementById('loginPrompt');
const uploadSection = uploadBtn.closest('section.card');
const objectsSection = fileList.closest('section.card');
const errorBanner = document.getElementById('errorBanner');
const objectRowTemplate = document.getElementById('objectRowTemplate');

const ICON_FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
const ICON_FILE = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM16 18H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
const ICON_DELETE = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>`;

let user = null;
let zones = [];        // [{name, endpoint}]
let bucket = null;
let currentPrefix = '';
let statusPollIntervalId = null;
let HAS_CONSISTENCY_API = true; // capability probe
// ====== UI auth state ======
function updateAuthUI() {
    const loggedIn = !!user;

    // Stop any background polling if the user is logged out.
    if (!loggedIn) {
        stopStatusPolling();
    }

    // Toggle visibility based on login state
    loginBtn.style.display = loggedIn ? 'none' : 'inline-block';
    loginPrompt.style.display = loggedIn ? 'none' : 'block';
    uploadSection.style.display = loggedIn ? 'block' : 'none';
    objectsSection.style.display = loggedIn ? 'block' : 'none';

    // Enable/disable controls
    zoneSel.disabled = !loggedIn;
}

// ====== UI Helpers ======
function resetUploadForm() {
    fileInput.value = '';
    fileChosen.textContent = 'No file selected.';
    uploadKey.value = '';
    uploadBtn.disabled = true;
    setTimeout(() => {
        // Only clear if it's still showing the success message
        if (uploadStatus.textContent === 'Done ✓') {
            uploadStatus.textContent = '';
        }
    }, 3000);
}

/** Stops any active status polling interval. */
function stopStatusPolling() {
    if (statusPollIntervalId) {
        clearInterval(statusPollIntervalId);
        statusPollIntervalId = null;
    }
}

/**
 * Updates the style and text of a status badge.
 * @param {HTMLElement} span The badge element.
 * @param {string} state The replication state ('Latest', 'Outdated', etc.).
 * @param {boolean} isDeleteMarker Whether the latest version is a delete marker.
 */
function updateBadge(span, state, isDeleteMarker) {
    if (!span) return;
    span.className = 'badge'; // Reset classes
    span.dataset.key = span.dataset.key; // Keep the key

    if (state === 'Latest') {
        if (isDeleteMarker) {
            span.textContent = 'Deleted';
            span.classList.add('b-del');
        } else {
            span.textContent = 'Latest';
            span.classList.add('b-ok');
        }
    } else if (state === 'Outdated') {
        span.textContent = 'Syncing…';
        span.classList.add('b-warn');
    } else {
        span.textContent = ''; // Hide for 'Unknown' or other states
    }
}

// ====== Zones ======
async function loadZones() {
    const data = await api.loadZones();
    zones = data.zones || data;
    bucket = data.bucket || bucket;

    zoneSel.innerHTML = '';
    zones.forEach(z => {
        const opt = document.createElement('option');
        opt.value = z.name;
        opt.textContent = `${z.name} (${z.endpoint || z.url || ''})`;
        zoneSel.appendChild(opt);
    });
    const last = localStorage.getItem('zoneName');
    if (last && zones.some(z => z.name === last)) zoneSel.value = last;
}

// ====== Replication status cache ======
const statusCache = new Map(); // key -> {state, isDeleteMarker, fetchedAt}
const STATUS_TTL_MS = 30_000;
const CONCURRENCY = 5;

async function fetchStatusForKey(key) {
    if (!HAS_CONSISTENCY_API) return {state: 'Unknown', isDeleteMarker: false, fetchedAt: Date.now()};
    const now = Date.now();
    const cached = statusCache.get(key);
    if (cached && (now - cached.fetchedAt) < STATUS_TTL_MS) return cached;

    const zoneName = zoneSel.value;
    try {
        const data = await api.checkConsistency(key, zoneName);
        let state = 'Unknown';
        let isDeleteMarker = false;
        for (const z of data.per_zone || []) {
            if (z.zone === zoneName) {
                state = z.state || 'Unknown';
                isDeleteMarker = !!(z.latest && z.latest.type === 'DeleteMarker');
                break;
            }
        }
        const obj = {state, isDeleteMarker, fetchedAt: now, check: data};
        statusCache.set(key, obj);
        return obj;
    } catch (e) {
        if (String(e).includes('404')) {
            HAS_CONSISTENCY_API = false;
            showStatus.checked = false;
            showStatus.disabled = true;
        }
        throw e;
    }
}

// ====== Breadcrumb / folder helpers ======
function buildBreadcrumb(prefix) {
    const parts = prefix ? prefix.replace(/\/+$/, "").split("/") : [];
    let path = "";
    const links = parts.map((part) => {
        path += `${part}/`;
        // Use data-prefix to avoid closure issues and simplify event handling
        return `<a href="#" class="link" data-prefix="${path}">${part}/</a>`;
    });

    breadcrumb.innerHTML = `
    <a href="#" class="link" data-prefix="">root</a>
    ${links.length > 0 ? " / " + links.join(" / ") : ""}
  `;
}

/** Navigates to a subfolder. */
function openFolder(name) {
    navigateTo((currentPrefix || '') + name); // name includes trailing '/'
}

/** Navigates to the parent folder. */
function goUp() {
    const p = (currentPrefix || '').replace(/\/+$/, '');
    if (!p) return;
    const parts = p.split('/');
    parts.pop();
    const newPrefix = parts.length ? parts.join('/') + '/' : '';
    navigateTo(newPrefix);
}

/**
 * Navigates to a specific prefix and refreshes the list.
 * This is the central navigation function.
 */
function navigateTo(prefix) {
    currentPrefix = prefix;
    statusCache.clear();
    listObjects();
}

/**
 * Fetches object list from the API and triggers rendering and status checks.
 * Handles loading and error states for the file list display.
 */
async function listObjects() { // Fetches and orchestrates rendering
    if (!user) return;

    // Show loading state immediately and handle errors centrally
    fileList.innerHTML = '<div class="small" style="padding: 12px 16px;">Loading...</div>';

    try {
        const zone = zoneSel.value;
        const prefix = currentPrefix;
        localStorage.setItem('zoneName', zone);

        const data = await api.listObjects(zone, prefix);
        const folders = data.folders || [];
        const items = data.items || [];

        buildBreadcrumb(prefix);
        fileList.innerHTML = ''; // Clear loading state
        const fragment = document.createDocumentFragment();

        // "Up one level" link
        if (prefix) {
            const row = objectRowTemplate.content.cloneNode(true);
            const link = row.querySelector('a.link');
            link.dataset.action = 'go-up';
            row.querySelector('.icon').innerHTML = ICON_FOLDER;
            row.querySelector('.link-text').textContent = '..';
            row.querySelector('.modified').textContent = '';
            row.querySelector('.size').textContent = '';
            row.querySelector('.badge').remove(); // No badge for "up" link
            fragment.appendChild(row);
        }

        // Folder rows
        folders.forEach(name => {
            const displayName = name.replace(/\/$/, '');
            const row = objectRowTemplate.content.cloneNode(true);
            const link = row.querySelector('a.link');
            link.dataset.action = 'open-folder';
            link.dataset.folderName = name;
            row.querySelector('.icon').innerHTML = ICON_FOLDER;
            row.querySelector('.link-text').textContent = displayName;
            row.querySelector('.modified').textContent = 'Folder';
            row.querySelector('.size').textContent = '—';
            row.querySelector('.badge').remove(); // No badge for folders
            fragment.appendChild(row);
        });

        // File rows
        const spansByKey = new Map(); // key -> badge element (only when enabled)
        const wantStatus = showStatus.checked;
        items.forEach(it => {
            const row = objectRowTemplate.content.cloneNode(true);
            const displayName = (prefix && it.key.startsWith(prefix)) ? it.key.substring(prefix.length) : it.key;
            const link = row.querySelector('a.link');
            link.dataset.action = 'download-object';
            link.dataset.key = it.key;
            row.querySelector('.icon').innerHTML = ICON_FILE;
            row.querySelector('.link-text').textContent = displayName;
            row.querySelector('.modified').textContent = formatDate(it.last_modified);
            row.querySelector('.size').textContent = formatSize(it.size);

            const badge = row.querySelector('.badge'); // Keep this reference
            if (wantStatus) {
                badge.dataset.key = it.key; // Add key to badge for easy selection later
            } else {
                badge.remove();
            }

            // Add delete button for file objects
            const actions = row.querySelector('.actions');
            if (actions) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn-icon';
                deleteBtn.title = 'Delete object';
                deleteBtn.dataset.action = 'delete-object';
                deleteBtn.dataset.key = it.key;
                deleteBtn.innerHTML = ICON_DELETE;
                actions.appendChild(deleteBtn);
            }

            fragment.appendChild(row);
        });

        if (fragment.childElementCount === 0) {
            fileList.innerHTML = '<div class="small" style="padding: 12px 16px;">No objects.</div>';
        } else {
            fileList.appendChild(fragment);
        }

        // Replication status (files only when enabled)
        if (wantStatus && items.length && HAS_CONSISTENCY_API) {
            const statusTasks = items.map(it => async () => {
                try {
                    const {state, isDeleteMarker} = await fetchStatusForKey(it.key);
                    const span = fileList.querySelector(`.badge[data-key="${it.key}"]`);
                    updateBadge(span, state, isDeleteMarker);
                } catch { /* Ignore individual errors */
                }
            });
            await promisePool(statusTasks, CONCURRENCY);
        }
    } catch (e) {
        console.error('Failed to list objects:', e);
        fileList.innerHTML = `<div class="small" style="padding: 12px 16px; color: red;">Failed to load objects: ${e.message}</div>`;
    }
}

// ====== Upload ======
fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) {
        const f = fileInput.files[0];
        fileChosen.textContent = f.name;
        uploadBtn.disabled = false;
        uploadKey.value = (currentPrefix || '') + f.name;
    } else {
        fileChosen.textContent = 'No file selected.';
        uploadBtn.disabled = true;
    }
});

async function doUpload() {
    // The user check is still necessary in case the UI state is somehow inconsistent.
    if (!user) {
        uploadStatus.textContent = 'Error: Please login first.';
        uploadStatus.style.color = 'red';
        setTimeout(() => {
            uploadStatus.textContent = '';
            uploadStatus.style.color = '';
        }, 3000);
        return;
    }
    // The check for a file (`if (!f)`) is removed, as the UI already disables the button if no file is selected.
    const f = fileInput.files[0];

    const zone = zoneSel.value;
    const key = uploadKey.value || f.name;

    try {
        uploadStatus.textContent = 'Uploading...';
        await api.uploadFile(zone, key, f);
        uploadStatus.textContent = 'Done ✓';
        resetUploadForm();
        statusCache.clear();

        // After a long operation like a large upload, the auth token may have expired.
        // Re-initializing the auth state can silently refresh the token before the next API call.
        user = await auth.refreshAuth();
        updateAuthUI();

        await listObjects();
    } catch (e) {
        console.error(e);
        uploadStatus.textContent = 'Error: ' + e.message;
    }
}

async function doDeleteObject(key) {
    if (!user) return;

    const displayName = key.endsWith('/') ? key.slice(0, -1).split('/').pop() + '/' : key.split('/').pop();
    if (!confirm(`Are you sure you want to delete "${displayName}"?\n\nIf versioning is enabled, this will create a delete marker.`)) {
        return;
    }

    try {
        const zone = zoneSel.value;
        await api.deleteObject(zone, key);
        // On successful deletion, clear the cache for this object and refresh the list
        statusCache.delete(key);

        // Re-check auth token freshness before refreshing the list to avoid errors after long pauses.
        user = await auth.refreshAuth();
        updateAuthUI();

        await listObjects();
    } catch (e) {
        console.error('Failed to delete object:', e);
        alert(`Error deleting object: ${e.message}`);
    }
}

// ====== Download with pre-check ======
async function presignDownload(zone, key, version_id = null) {
    const url = await api.getDownloadUrl(zone, key, version_id);
    window.open(url, '_blank');
}

async function downloadObject(key) {
    if (!user) {
        alert('Please login first.');
        return;
    }
    const currentZone = zoneSel.value;
    return presignDownload(currentZone, key);
}

// ====== Bindings ======
loginBtn.addEventListener('click', auth.login);
zoneSel.addEventListener('change', () => {
    (async () => {
        if (!user) return;
        // Re-check auth token freshness before making API calls.
        user = await auth.refreshAuth();
        updateAuthUI();
        statusCache.clear();
        await listObjects();
    })();
});
uploadBtn.addEventListener('click', doUpload);
showStatus.addEventListener('change', () => {
    stopStatusPolling();

    const pollFn = async () => {
        // This function will be used for the immediate refresh and the interval.
        if (!auth.getUser()) {
            stopStatusPolling(); // Stop if user somehow logged out
            return;
        }
        try {
            user = await auth.refreshAuth(); // Ensure token is fresh
            if (!user) {
                stopStatusPolling();
                updateAuthUI(); // Show login prompt if session expired
                return;
            }
            statusCache.clear(); // We want a full, fresh update
            await listObjects();
        } catch (e) {
            console.error("Auto-refresh failed:", e);
            // listObjects() will render the error in the UI, so we just log it here.
        }
    };

    // Run once immediately to reflect the checkbox change.
    pollFn();

    if (showStatus.checked) {
        // If "Auto refresh" is enabled, start the 10-second polling interval.
        statusPollIntervalId = setInterval(pollFn, 10_000);
    }
});

// Event delegation for dynamic content (file list, breadcrumb)
document.body.addEventListener('click', (e) => {
    // Handle icon button clicks (e.g., delete)
    const button = e.target.closest('button.btn-icon');
    if (button) {
        const action = button.dataset.action;
        if (action === 'delete-object') {
            e.preventDefault();
            doDeleteObject(button.dataset.key);
        }
        return;
    }

    // Handle all link-based actions (navigation, download)
    const link = e.target.closest('a.link');
    if (link) {
        e.preventDefault(); // Prevent default for all handled link clicks
        const action = link.dataset.action;
        const prefix = link.dataset.prefix;

        if (action === 'go-up') {
            goUp();
        } else if (action === 'open-folder') {
            openFolder(link.dataset.folderName);
        } else if (action === 'download-object') {
            downloadObject(link.dataset.key);
        } else if (typeof prefix !== 'undefined') {
            // This handles breadcrumb clicks, which don't have a data-action
            navigateTo(prefix);
        }
    }
});

// ====== Boot (no auto-login; only restore if existing) ======
(async () => {
    try {
        user = await auth.initAuth();
        updateAuthUI(); // This now handles all UI state changes
        if (user) {
            await loadZones();
            await listObjects();
        }
    } catch (e) {
        console.error(e);
        errorBanner.textContent = 'Failed to initialize: ' + e.message;
        errorBanner.style.display = 'block';
    }
})();