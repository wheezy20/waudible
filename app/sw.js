// ─────────────────────────────────────────
// WAUDIBLE SERVICE WORKER (served at /sw.js by app/main.py, which fills
// in the version and the shell file list)
//
// - Navigations: network first. With no network, the precached /offline
//   page, which lists this account's downloads from IndexedDB.
// - App shell (CSS, JS, icons, the offline page): cache first.
// - Downloaded media (/audio and /cover of downloaded books): cache first
//   from the signed-in user's own cache, with Range support (206) so
//   seeking works offline. Only offline.js puts files there.
// - Everything else (HTML pages, JSON, form posts) goes to the network
//   and is never cached.
// ─────────────────────────────────────────
const VERSION    = '__VERSION__';
const SHELL      = `waudible-shell-${VERSION}`;
const FONTS      = 'waudible-fonts-v1';
const SHELL_URLS = __SHELL_URLS__;
const FONT_CSS   = __FONT_CSS__;
const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const MEDIA      = /^\/(audio|cover)\/\d+(\/\d+)?$/;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        // Straight from the server, not the browser's HTTP cache
        await cache.addAll(SHELL_URLS.map(u => new Request(u, { cache: 'reload' })));
        try {
            const fonts = await caches.open(FONTS);
            const r = await fetch(FONT_CSS, { mode: 'cors' });
            if (r.ok) await fonts.put(FONT_CSS, r);
        } catch (e) { /* fonts fall back to the system font offline */ }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const name of await caches.keys()) {
            if (name.startsWith('waudible-shell-') && name !== SHELL) await caches.delete(name);
        }
        await self.clients.claim();
    })());
});

// ── WHO IS SIGNED IN (set by offline.js, also kept in IndexedDB) ──
let currentUser;    // undefined: not read yet; null: nobody

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'user') currentUser = event.data.uid == null ? null : Number(event.data.uid);
});

function readUser() {
    return new Promise(resolve => {
        const r = indexedDB.open('waudible', 1);
        r.onupgradeneeded = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('books'))    db.createObjectStore('books', { keyPath: ['uid', 'id'] });
            if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: ['uid', 'id'] });
            if (!db.objectStoreNames.contains('meta'))     db.createObjectStore('meta', { keyPath: 'key' });
        };
        r.onerror = () => resolve(null);
        r.onsuccess = () => {
            try {
                const g = r.result.transaction('meta', 'readonly').objectStore('meta').get('user');
                g.onsuccess = () => { r.result.close(); resolve(g.result ? g.result.uid : null); };
                g.onerror = () => { r.result.close(); resolve(null); };
            } catch (e) { resolve(null); }
        };
    });
}

async function user() {
    if (currentUser === undefined) currentUser = await readUser();
    return currentUser;
}

// ── FETCH ──
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (FONT_HOSTS.includes(url.origin)) {
        event.respondWith(fonts(req));
        return;
    }
    if (url.origin !== self.location.origin) return;

    if (req.mode === 'navigate') {
        event.respondWith(fetch(req).catch(offlinePage));
        return;
    }
    if (SHELL_URLS.includes(url.pathname) && !url.search) {
        event.respondWith(caches.match(url.pathname, { cacheName: SHELL }).then(hit => hit || fetch(req)));
        return;
    }
    if (MEDIA.test(url.pathname)) {
        event.respondWith(media(req, url));
    }
    // Anything else: the network, untouched and never cached
});

async function offlinePage() {
    const page = await caches.match('/offline', { cacheName: SHELL });
    return page || Response.error();
}

async function fonts(req) {
    const cache = await caches.open(FONTS);
    const hit = await cache.match(req.url);
    if (hit) return hit;
    const res = await fetch(req.url, { mode: 'cors' });
    if (res.ok) cache.put(req.url, res.clone());
    return res;
}

async function media(req, url) {
    const uid = await user();
    if (uid != null) {
        const cache = await caches.open(`waudible-media-u${uid}`);
        const hit = await cache.match(url.href);
        if (hit) return ranged(hit, req.headers.get('Range'));
    }
    return fetch(req);
}

// The <audio> element asks for byte ranges; answer like a server would
async function ranged(response, range) {
    if (!range) return response;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return response;    // several ranges or odd syntax: whole file
    const blob = await response.blob();
    const total = blob.size;
    let start, end;
    if (m[1] === '') {                      // last N bytes
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    }
    if (start >= total || start > end) {
        return new Response(null, { status: 416, statusText: 'Range Not Satisfiable',
                                    headers: { 'Content-Range': `bytes */${total}` } });
    }
    return new Response(blob.slice(start, end + 1), {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type'  : response.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Length': String(end - start + 1),
            'Content-Range' : `bytes ${start}-${end}/${total}`,
            'Accept-Ranges' : 'bytes',
        },
    });
}
