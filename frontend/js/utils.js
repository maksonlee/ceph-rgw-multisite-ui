/**
 * Formats an ISO string to 'YYYY-MM-DD HH:mm'.
 * @param {string | null} isoString
 * @returns {string}
 */
export function formatDate(isoString) {
    if (!isoString) return '';
    try {
        const d = new Date(isoString);
        const pad = (num) => String(num).padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hours = pad(d.getHours());
        const minutes = pad(d.getMinutes());
        return `${year}-${month}-${day} ${hours}:${minutes}`;
    } catch (e) {
        return isoString; // Fallback on error
    }
}

/**
 * Formats bytes into a human-readable string (KB, MB, GB).
 * @param {number | string} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
    const b = parseInt(bytes, 10) || 0;
    if (b === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));

    const num = b / Math.pow(k, i);
    // For B, no decimal. For others, one decimal.
    const formattedNum = (i === 0) ? num.toLocaleString() : num.toFixed(1);

    return `${formattedNum} ${sizes[i]}`;
}

/**
 * A simple promise pool to limit concurrency.
 * @param {Array<() => Promise<any>>} tasks - An array of functions that return a promise.
 * @param {number} limit - The concurrency limit.
 * @returns {Promise<any[]>}
 */
export function promisePool(tasks, limit = 5) {
    let i = 0, running = 0, out = [];
    return new Promise((resolve) => {
        const next = () => {
            if (i === tasks.length && running === 0) return resolve(Promise.all(out));
            while (running < limit && i < tasks.length) {
                const t = tasks[i++]();
                running++;
                out.push(t.finally(() => {
                    running--;
                    next();
                }));
            }
        };
        next();
    });
}