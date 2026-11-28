// ─────────────────────────────────────────
// DOWNLOAD STORAGE (shared)
// Loaded by the page (before offline.js) and by the service worker
// (importScripts in sw.js), so a book downloaded by the app's own loop
// and one downloaded by Background Fetch end up stored the same way:
//   - each file checked against the size the server gave (or, for a page
//     made on demand, its Content-Length) before it is kept;
//   - kept in this account's Cache Storage, "waudible-media-u<user id>",
//     under the URL the player uses;
//   - the book's IndexedDB record ("waudible", store "books", key
//     [user id, book id]) updated: the page moves from pending to have.
// ─────────────────────────────────────────
(function (scope) {
    const cacheName = u => `waudible-media-u${u}`;

    let dbPromise = null;
    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const r = indexedDB.open('waudible', 1);
                r.onupgradeneeded = () => {
                    const db = r.result;
                    if (!db.objectStoreNames.contains('books'))    db.createObjectStore('books', { keyPath: ['uid', 'id'] });
                    if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: ['uid', 'id'] });
                    if (!db.objectStoreNames.contains('meta'))     db.createObjectStore('meta', { keyPath: 'key' });
                };
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => { dbPromise = null; reject(r.error); };
            });
        }
        return dbPromise;
    }
    const done = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const store = async mode => (await openDb()).transaction('books', mode).objectStore('books');
    const getBook = async (u, id) => done((await store('readonly')).get([Number(u), Number(id)]));
    const putBook = async rec => done((await store('readwrite')).put(rec));
    const deleteBook = async (u, id) => done((await store('readwrite')).delete([Number(u), Number(id)]));

    const audioFile = (rec, p) => rec.files.find(f => f.kind === 'audio' && f.page === p);
    const artFiles = rec => rec.files.filter(f => f.kind !== 'audio');
    function storedBytes(rec) {
        let n = rec.art ? artFiles(rec).reduce((t, f) => t + (f.bytes || 0), 0) : 0;
        for (const p of rec.have) n += ((audioFile(rec, p) || {}).bytes || 0) + ((rec.textBytes || [])[p] || 0);
        return n;
    }

    // Why a file wasn't kept: 'status' (the server said no), 'size' (cut short)
    class StoreError extends Error {
        constructor(reason) { super(reason); this.reason = reason; }
    }

    // Already here at the right size (a resumed download skips it)
    async function isStored(cache, f) {
        const hit = await cache.match(f.url);
        return !!(hit && f.bytes != null && Number(hit.headers.get('Content-Length')) === f.bytes);
    }

    async function storeResponse(cache, f, response) {
        if (!response || !response.ok || response.redirected || response.type === 'opaqueredirect') throw new StoreError('status');
        const blob = await response.blob();
        // Pages without audio for this voice are made on demand, so their
        // size is only known now
        const expected = f.bytes != null ? f.bytes : Number(response.headers.get('Content-Length') || blob.size);
        if (!blob.size || blob.size !== expected) throw new StoreError('size');
        f.bytes = blob.size;
        await cache.put(f.url, new Response(blob, { headers: {
            'Content-Type': response.headers.get('Content-Type') || blob.type || 'application/octet-stream',
            'Content-Length': String(blob.size),
        } }));
    }

    // A file is kept: an audio file moves its page from pending to have
    function markStored(rec, f) {
        if (f.kind !== 'audio') return;
        if (!rec.have.includes(f.page)) rec.have.push(f.page);
        rec.pending = rec.pending.filter(p => p !== f.page);
    }

    async function artStored(cache, rec) {
        for (const f of artFiles(rec)) if (!(await isStored(cache, f))) return false;
        return true;
    }

    // Lists sorted, totals up to date (call before putBook)
    function settle(rec) {
        rec.have.sort((a, b) => a - b);
        rec.pending.sort((a, b) => a - b);
        rec.complete = rec.pending.length === 0;
        if (rec.complete) rec.savedAt = Date.now();
        rec.bytes = storedBytes(rec);
        return rec;
    }

    scope.DlStore = { cacheName, openDb, getBook, putBook, deleteBook, audioFile, artFiles, storedBytes,
                      StoreError, isStored, storeResponse, markStored, artStored, settle };
})(self);
