// ─────────────────────────────────────────
// OFFLINE LISTENING
// Downloads a finished book to this device and keeps it per account:
//   IndexedDB "waudible": books (details, contents, page text, file list),
//                         progress (positions saved here, synced later),
//                         meta (who is signed in on this device)
//   Cache Storage "waudible-media-u<user id>": the cover and page audio,
//                         under the same URLs the player uses, so the
//                         service worker (sw.js) can serve them offline.
// Everything is keyed by user id, so another account on the same browser
// never sees these downloads, and logging out deletes them.
// ─────────────────────────────────────────
(function () {
    const $ = id => document.getElementById(id);
    const shellOffline = document.body.dataset.shell === 'offline';
    const userMeta = document.querySelector('meta[name="waudible-user"]');
    const LATER_MS = 7 * 24 * 3600 * 1000;      // "Not now" asks again after a week
    const toast = msg => window.App && App.toast(msg);
    const cacheName = u => `waudible-media-u${u}`;

    function size(bytes) {
        const mb = bytes / 1e6;
        return (mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()) + ' MB';
    }

    // ── INDEXEDDB ──
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
                r.onerror = () => reject(r.error);
            });
        }
        return dbPromise;
    }
    const done = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    async function os(name, mode) { return (await openDb()).transaction(name, mode).objectStore(name); }
    const get = async (name, key) => done((await os(name, 'readonly')).get(key));
    const put = async (name, value) => done((await os(name, 'readwrite')).put(value));
    const del = async (name, key) => done((await os(name, 'readwrite')).delete(key));
    const allOf = async (name, u) => (await done((await os(name, 'readonly')).getAll())).filter(r => r.uid === u);

    // ── WHO IS SIGNED IN ON THIS DEVICE ──
    // Online pages carry the user id; the offline page has none and uses
    // the last account that signed in here (cleared on log out).
    let uid = null, userName = '';
    const known = new Map();    // book id -> { complete, bytes, voice } for this user

    async function refreshKnown() {
        known.clear();
        if (uid == null) return;
        try {
            for (const r of await allOf('books', uid)) known.set(r.id, { complete: r.complete, bytes: r.bytes, voice: r.voice, title: r.title });
        } catch (e) { /* storage unavailable */ }
    }

    function tellWorker() {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'user', uid });
        }
    }

    const ready = (async () => {
        try {
            if (userMeta) {
                uid = Number(userMeta.content);
                userName = userMeta.dataset.name || '';
                await put('meta', { key: 'user', uid, name: userName });
            } else {
                const u = await get('meta', 'user');
                if (u) { uid = u.uid; userName = u.name || ''; }
            }
        } catch (e) { /* private mode or storage blocked: no offline features */ }
        await refreshKnown();
        tellWorker();
        const nameEl = $('offline-user-name');
        if (nameEl) nameEl.textContent = userName;
    })();

    // ── SERVICE WORKER ──
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => { /* offline or unsupported */ });
        navigator.serviceWorker.addEventListener('controllerchange', () => ready.then(tellWorker));
    }

    // ── ONLINE OR OFFLINE ──
    let online = navigator.onLine;
    const isOnline = () => online && !shellOffline;

    function renderNetwork() {
        const off = !isOnline();
        document.body.classList.toggle('is-offline', off);
        $('offline-badge').hidden = !off;
        updateActions();
        document.dispatchEvent(new CustomEvent('waudible:network', { detail: { online: !off } }));
    }

    window.addEventListener('online',  () => { online = true;  renderNetwork(); whenOnline(); });
    const retry = $('offline-retry');
    if (retry) retry.addEventListener('click', () => window.location.reload());
    window.addEventListener('offline', () => { online = false; renderNetwork(); });

    function whenOnline() {
        if (!isOnline()) return;
        sync().then(reconcile).then(resumeAll).catch(() => {});
    }

    // ── STORAGE SPACE ──
    async function freeSpace() {
        try {
            const e = await navigator.storage.estimate();
            return Math.max(0, e.quota - e.usage);
        } catch (e) { return null; }
    }
    function persist() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
            }
        } catch (e) { /* not supported */ }
    }
    const enoughFor = (space, bytes) => space === null || space >= bytes * 1.1 + 5e6;
    const spaceMessage = (need, space) =>
        `Not enough space on this device. This book needs about ${size(need)} and only ${size(space)} is free. Delete some downloads or free up space, then try again.`;

    // Server's estimate for the confirm step and the suggestion
    const estimates = new Map();
    async function estimate(id) {
        if (estimates.has(id)) return estimates.get(id);
        const r = await fetch(`/offline/size/${id}`, { headers: { 'Accept': 'application/json' } });
        if (!r.ok || r.redirected) throw new Error(r.status);
        const e = await r.json();
        estimates.set(id, e);
        return e;
    }

    // ── DOWNLOAD ──
    const jobs = new Map();     // book id -> { ctrl, done, total, cancelled, error }
    class DlError extends Error {}

    function state(id) {
        id = Number(id);
        const job = jobs.get(id), k = known.get(id);
        if (job) return { name: 'downloading', pct: job.total ? Math.round(100 * job.done / job.total) : 0, job };
        if (k && k.complete) return { name: 'downloaded', bytes: k.bytes, voice: k.voice };
        if (k) return { name: 'partial' };
        return { name: 'none' };
    }

    async function dropFiles(cache, files) {
        for (const f of files || []) await cache.delete(f.url);
    }

    async function download(id, { quiet = false } = {}) {
        id = Number(id);
        await ready;
        if (uid == null || jobs.has(id)) return;
        if (!isOnline()) { toast('Downloading needs a connection.'); return; }
        const me = uid;
        const job = { ctrl: new AbortController(), done: 0, total: 0, cancelled: false, error: '' };
        const signal = job.ctrl.signal;
        jobs.set(id, job);
        changed(id);
        persist();
        try {
            const res = await fetch(`/offline/manifest/${id}`, { signal, headers: { 'Accept': 'application/json' } });
            if (res.status === 409) throw new DlError('This book is still being prepared. Download it when its audio is ready.');
            if (!res.ok || res.redirected) throw new DlError("The download couldn't start. Please try again.");
            const man = await res.json();

            const cache = await caches.open(cacheName(me));
            let rec = await get('books', [me, id]);
            if (rec && rec.voice !== man.voice) { await dropFiles(cache, rec.files); rec = null; }

            const space = await freeSpace();
            const need = man.bytes - (rec ? rec.stored || 0 : 0);
            if (!enoughFor(space, need)) throw new DlError(spaceMessage(need, space));

            rec = { uid: me, id, title: man.title, author: man.author, genre: man.genre, pages: man.pages,
                    voice: man.voice, cover: man.cover, toc: man.toc, texts: man.texts, files: man.files,
                    bytes: man.bytes, stored: rec ? rec.stored || 0 : 0, complete: false, savedAt: Date.now() };
            await put('books', rec);
            await refreshKnown();
            // Start from where the server says the listener is, unless this
            // device has its own position
            if (man.progress && !(await get('progress', [me, id]))) {
                await put('progress', { uid: me, id, page: man.progress.page, speed: man.progress.speed,
                                        voice: man.voice, at: man.progress.at, synced: true });
            }

            job.total = man.files.length;
            for (const f of man.files) {
                if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                const have = await cache.match(f.url);
                if (have && f.bytes != null && Number(have.headers.get('Content-Length')) === f.bytes) {
                    job.done++; changed(id); continue;
                }
                const r = await fetch(f.url, { signal, cache: 'no-store' });
                if (!r.ok || r.redirected) throw new DlError("Part of the book couldn't be downloaded. Please try again.");
                const blob = await r.blob();
                // Pages without audio for this voice are made on demand, so
                // their size is only known now
                const expected = f.bytes != null ? f.bytes : Number(r.headers.get('Content-Length') || blob.size);
                if (blob.size !== expected) throw new DlError("A file didn't download completely. Please try again.");
                f.bytes = blob.size;
                await cache.put(f.url, new Response(blob, { headers: {
                    'Content-Type': r.headers.get('Content-Type') || blob.type || 'application/octet-stream',
                    'Content-Length': String(blob.size),
                } }));
                rec.stored += blob.size;
                job.done++;
                if (job.done % 5 === 0) await put('books', rec);   // for resuming
                changed(id);
            }
            rec.files = man.files;
            rec.bytes = man.files.reduce((n, f) => n + (f.bytes || 0), 0) + man.texts.reduce((n, t) => n + t.length, 0);
            rec.complete = true;
            rec.savedAt = Date.now();
            await put('books', rec);
            if (!quiet) toast(`Downloaded "${man.title}". It plays without a connection.`);
        } catch (e) {
            if (job.cancelled) {
                await removeFor(me, id);
                toast('Download cancelled.');
            } else if (e instanceof DlError) {
                job.error = e.message;
                // Nothing useful kept when it never started
                const rec = await get('books', [me, id]).catch(() => null);
                if (rec && !rec.stored) await removeFor(me, id);
                toast(e.message);
            } else {
                job.error = 'The download stopped. It carries on when you are back online.';
                toast(job.error);
            }
            lastError.set(id, job.error);
        } finally {
            jobs.delete(id);
            await refreshKnown();
            changed(id);
        }
    }
    const lastError = new Map();

    function cancel(id) {
        const job = jobs.get(Number(id));
        if (!job) return;
        job.cancelled = true;
        job.ctrl.abort();
    }

    async function removeFor(u, id) {
        try {
            const rec = await get('books', [u, id]);
            if (rec) {
                await dropFiles(await caches.open(cacheName(u)), rec.files);
                await del('books', [u, id]);
            }
        } catch (e) { /* already gone */ }
    }

    async function remove(id) {
        id = Number(id);
        await ready;
        if (uid == null) return;
        if (jobs.has(id)) cancel(id);
        await removeFor(uid, id);
        await refreshKnown();
        changed(id);
    }

    async function removeAll() {
        await ready;
        if (uid == null) return;
        for (const id of jobs.keys()) cancel(id);
        for (const rec of await allOf('books', uid)) await del('books', [uid, rec.id]);
        await caches.delete(cacheName(uid));
        await refreshKnown();
        changed(null);
    }

    // Downloads that stopped part way carry on when the app is online
    async function resumeAll() {
        if (!isOnline() || uid == null) return;
        for (const rec of await allOf('books', uid)) {
            if (!rec.complete && !jobs.has(rec.id)) download(rec.id, { quiet: true });
        }
    }

    // A book deleted on the server (here or on another device) loses its
    // downloaded copy the next time the app is online
    async function reconcile() {
        await ready;
        if (uid == null || !isOnline()) return;
        let data;
        try {
            const r = await fetch('/offline/books', { headers: { 'Accept': 'application/json' } });
            if (!r.ok || r.redirected) return;
            data = await r.json();
        } catch (e) { return; }
        if (data.user !== uid) return;
        const ids = new Set(data.books);
        for (const rec of await allOf('books', uid)) {
            if (!ids.has(rec.id)) { await remove(rec.id); if (window.Player) Player.forget(rec.id); }
        }
        for (const p of await allOf('progress', uid)) {
            if (!ids.has(p.id)) await del('progress', [uid, p.id]);
        }
    }

    // ── PROGRESS: saved here first, sent to the server when possible ──
    async function saveProgress(id, p) {
        await ready;
        if (uid == null) return null;
        const rec = { uid, id: Number(id), page: p.page, speed: p.speed, voice: p.voice, at: Date.now(), synced: false };
        try { await put('progress', rec); } catch (e) { return null; }
        return rec.at;
    }

    async function markSynced(id, at) {
        if (uid == null || at == null) return;
        try {
            const r = await get('progress', [uid, Number(id)]);
            if (r && r.at === at && !r.synced) { r.synced = true; await put('progress', r); }
        } catch (e) { /* stays unsynced, sent later */ }
    }

    // Latest position per book, last write wins by time (the server
    // ignores a position older than the one it has). A failed send keeps
    // the position for the next try.
    let syncing = null;
    function sync() {
        if (!syncing) syncing = doSync().catch(() => {}).finally(() => { syncing = null; });
        return syncing;
    }
    async function doSync() {
        await ready;
        if (uid == null || !isOnline()) return;
        const me = uid;
        const pending = (await allOf('progress', me)).filter(p => !p.synced);
        if (!pending.length) return;
        const t = await fetch('/offline/csrf', { headers: { 'Accept': 'application/json' } });
        if (!t.ok || t.redirected) return;
        const token = (await t.json()).token;
        for (const p of pending) {
            const r = await fetch('/save_progress', {
                method : 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': token },
                body   : JSON.stringify({ book_id: p.id, page: p.page, speed: p.speed, voice: p.voice, at: p.at }),
            });
            if (r.ok) await markSynced(p.id, p.at);
            else if (r.status === 404) await del('progress', [me, p.id]);   // book deleted
        }
    }

    // ── WHAT THE PLAYER NEEDS ──
    async function localBook(id) {
        await ready;
        if (uid == null) return null;
        try {
            const r = await get('books', [uid, Number(id)]);
            return r && r.complete ? r : null;
        } catch (e) { return null; }
    }

    // The player's book data from a downloaded copy, merged with what the
    // server said (when online). A newer position saved on this device wins.
    async function playerData(rec, server) {
        let p = null;
        try { p = await get('progress', [uid, rec.id]); } catch (e) { /* none */ }
        const data = server ? { ...server } : {
            id: rec.id, title: rec.title, author: rec.author, genre: rec.genre, pages: rec.pages,
            page: 0, speed: 1, running: false, updated: 0,
        };
        if (p && (!server || (!p.synced && p.at > (server.updated || 0)))) {
            data.page = p.page;
            data.speed = p.speed;
        }
        data.page  = Math.min(Math.max(0, data.page || 0), rec.pages - 1);
        data.voice = rec.voice;
        data.cover = rec.cover;
        data.local = rec;
        return data;
    }

    // ── UI: cards, menu items, the download sheet ──
    let sheetBook = null;       // { id, title } shown in the download sheet

    function changed(id) {
        decorateCards();
        updateActions();
        if (sheetBook && (id == null || sheetBook.id === id)) renderSheet();
        renderLists();
    }

    function decorateCards(root = document) {
        root.querySelectorAll('.book-card[data-book-id]').forEach(card => {
            const s = state(card.dataset.bookId);
            card.classList.toggle('is-downloaded', s.name === 'downloaded');
            card.classList.toggle('is-downloading', s.name === 'downloading');
            const badge = card.querySelector('.cover-offline');
            if (badge) badge.style.setProperty('--p', (s.pct || 0) + '%');
        });
    }

    // "Download for offline" in the book menu and the player's More sheet
    function updateActions() {
        document.querySelectorAll('[data-download-action]').forEach(btn => {
            const id = btn.dataset.bookId;
            const label = btn.querySelector('.dl-action-label');
            if (!id) { btn.hidden = true; return; }
            btn.hidden = false;
            const s = state(id);
            let text = 'Download for offline', disabled = false;
            if (s.name === 'downloading') text = `Downloading ${s.pct}%`;
            else if (s.name === 'downloaded') text = 'Downloaded to this device';
            else if (btn.dataset.ready !== '1') { text = 'Download (when the audio is ready)'; disabled = true; }
            else if (!isOnline()) { text = 'Download (needs a connection)'; disabled = true; }
            else if (s.name === 'partial') text = 'Resume download';
            label.textContent = text;
            btn.disabled = disabled;
            btn.classList.toggle('is-done', s.name === 'downloaded');
        });
    }

    function setSheetState(name) {
        for (const n of ['confirm', 'progress', 'done']) $('dl-' + n).hidden = n !== name;
    }

    async function renderSheet() {
        if (!sheetBook) return;
        const id = sheetBook.id, s = state(id);
        $('dl-book').textContent = sheetBook.title;
        if (s.name === 'downloading') {
            setSheetState('progress');
            $('dl-ring').style.setProperty('--p', s.pct + '%');
            $('dl-pct').textContent = s.pct + '%';
            $('dl-progress-text').textContent = s.job.total
                ? `Downloading page audio and text, ${s.job.done} of ${s.job.total} files.` : 'Starting...';
            return;
        }
        if (s.name === 'downloaded') {
            setSheetState('done');
            $('dl-done-text').textContent =
                `Downloaded: ${size(s.bytes)} with the voice ${s.voice}. It plays without a connection; other voices need one.`;
            return;
        }
        setSheetState('confirm');
        const start = $('dl-start'), err = $('dl-error');
        err.textContent = lastError.get(id) || '';
        start.disabled = true;
        $('dl-size').textContent = '...';
        $('dl-voice-note').textContent = '';
        if (!isOnline()) { err.textContent = 'Downloading needs a connection.'; return; }
        let e;
        try { e = await estimate(id); } catch (x) { err.textContent = "Couldn't check the size. Please try again."; return; }
        if (!sheetBook || sheetBook.id !== id) return;
        $('dl-size').textContent = size(e.bytes);
        $('dl-voice-note').textContent =
            `Only the voice you listen with (${e.voice}) is downloaded. Other voices need a connection.`;
        if (!e.ready) { err.textContent = 'This book is still being prepared. Download it when its audio is ready.'; return; }
        const space = await freeSpace();
        if (!enoughFor(space, e.bytes)) { err.textContent = spaceMessage(e.bytes, space); return; }
        start.disabled = false;
    }

    function openSheet(id, title, opener) {
        sheetBook = { id: Number(id), title: title || '' };
        lastError.delete(sheetBook.id);
        renderSheet();
        Sheets.open('download-sheet', opener, { onClose: () => { sheetBook = null; } });
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-download-action]');
        if (!btn || btn.disabled) return;
        openSheet(btn.dataset.bookId, btn.dataset.title, btn);
    });
    $('dl-start').addEventListener('click', () => {
        if (!sheetBook) return;
        download(sheetBook.id);
        renderSheet();
    });
    $('dl-cancel').addEventListener('click', () => { if (sheetBook) cancel(sheetBook.id); });
    $('dl-remove').addEventListener('click', async () => {
        if (!sheetBook) return;
        const id = sheetBook.id;
        Sheets.close();
        await remove(id);
        toast('Removed from this device.');
    });

    // ── THE SUGGESTION: download instead of streaming ──
    const askKey = id => `waudible:ask:${uid}:${id}`;
    const askedNow = new Set();     // shown once per visit at most
    let askBook = null, answered = false;

    function askChoice(id) {
        try { return JSON.parse(localStorage.getItem(askKey(id)) || 'null'); } catch (e) { return null; }
    }
    function remember(id, choice) {
        try { localStorage.setItem(askKey(id), JSON.stringify({ choice, at: Date.now() })); } catch (e) { /* not kept */ }
    }

    async function maybeAsk(book) {
        await ready;
        if (uid == null || !book || !isOnline() || book.running || book.local) return;
        const id = book.id;
        if (askedNow.has(id) || state(id).name !== 'none') return;
        const c = askChoice(id);
        if (c && (c.choice === 'never' || (c.choice === 'later' && Date.now() - c.at < LATER_MS))) return;
        let e;
        try { e = await estimate(id); } catch (x) { return; }
        if (!e.ready || !enoughFor(await freeSpace(), e.bytes)) return;
        // Still the book on screen, with nothing else open
        if (!window.Player || Player.bookId() !== id || !Player.isExpanded() || Sheets.anyOpen()) return;
        askedNow.add(id);
        askBook = id;
        answered = false;
        $('ask-size').textContent = size(e.bytes);
        Sheets.open('ask-sheet', null, { onClose: () => { if (!answered) remember(id, 'later'); askBook = null; } });
    }

    $('ask-download').addEventListener('click', () => {
        const id = askBook; answered = true;
        Sheets.close();
        toast('Downloading. Follow it in Library, Downloads.');
        download(id);
    });
    $('ask-later').addEventListener('click', () => { remember(askBook, 'later'); answered = true; Sheets.close(); });
    $('ask-never').addEventListener('click', () => { remember(askBook, 'never'); answered = true; Sheets.close(); });

    // ── DOWNLOADS SCREEN AND THE OFFLINE PAGE ──
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    let confirmAll = false;

    async function renderLists() {
        const box = document.querySelector('#app-content #downloads');
        const link = $('downloads-link-sub');
        if (!box && !link) return;
        await ready;
        let books = [];
        try { books = uid == null ? [] : await allOf('books', uid); } catch (e) { /* none */ }
        books.sort((a, b) => b.savedAt - a.savedAt);
        const complete = books.filter(b => b.complete);
        const used = complete.reduce((n, b) => n + (b.bytes || 0), 0);
        if (link) {
            link.textContent = complete.length
                ? `${complete.length} ${complete.length === 1 ? 'book' : 'books'}, ${size(used)} on this device`
                : 'Listen without a connection';
        }
        if (!box) return;
        const offlineView = !!box.closest('[data-view="offline"]');
        const list = offlineView ? complete : books;
        box.replaceChildren();

        if (!list.length) {
            box.append(el('p', 'downloads-empty', uid == null
                ? 'Log in while you are online to download books for offline listening.'
                : offlineView
                    ? 'No books are downloaded on this device yet. When you are back online, open a book and choose Download for offline.'
                    : 'Nothing downloaded yet. Open a book, then choose Download for offline in its menu or in the player’s More menu.'));
            return;
        }

        const summary = el('div', 'downloads-summary');
        summary.append(el('p', 'downloads-total',
            `${complete.length} ${complete.length === 1 ? 'book' : 'books'}, ${size(used)} used on this device`));
        if (!offlineView) {
            const all = el('button', 'btn btn-ghost btn-pill btn-sm', 'Delete all');
            all.type = 'button';
            all.id = 'downloads-delete-all';
            all.addEventListener('click', () => { confirmAll = true; renderLists(); });
            summary.append(all);
        }
        box.append(summary);

        if (confirmAll && !offlineView) {
            const c = el('div', 'downloads-confirm');
            c.append(el('p', 'confirm-text', 'Delete every download from this device? The books stay in your library and can be downloaded again.'));
            const row = el('div', 'confirm-actions');
            const no = el('button', 'btn btn-ghost btn-pill', 'Cancel');
            const yes = el('button', 'btn btn-danger-solid btn-pill', 'Delete all');
            no.type = yes.type = 'button';
            yes.id = 'downloads-delete-all-confirm';
            no.addEventListener('click', () => { confirmAll = false; renderLists(); });
            yes.addEventListener('click', async () => {
                confirmAll = false;
                await removeAll();
                toast('All downloads deleted from this device.');
            });
            row.append(no, yes);
            c.append(row);
            box.append(c);
        }

        const ul = el('ul', 'downloads-list');
        for (const rec of list) {
            const s = state(rec.id);
            const li = el('li', 'dl-item');
            li.dataset.bookId = rec.id;
            const open = el('a', 'dl-open');
            open.href = `/read/${rec.id}`;
            open.dataset.openBook = rec.id;
            open.setAttribute('hx-boost', 'false');
            open.setAttribute('aria-label', `Play ${rec.title}`);
            const img = el('img', 'dl-cover');
            img.src = rec.cover;
            img.alt = '';
            const info = el('span', 'dl-info');
            info.append(el('span', 'dl-title', rec.title));
            let meta;
            if (s.name === 'downloading') meta = `Downloading ${s.pct}%`;
            else if (rec.complete) meta = `${size(rec.bytes)}, voice ${rec.voice}`;
            else meta = isOnline() ? 'Incomplete, resuming' : 'Incomplete. It carries on when you are back online.';
            info.append(el('span', 'dl-meta', meta));
            if (!rec.complete) open.removeAttribute('data-open-book');
            open.append(img, info);
            const rm = el('button', 'icon-btn dl-delete');
            rm.type = 'button';
            rm.setAttribute('aria-label', `Delete the download of ${rec.title}`);
            rm.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/></svg>';
            rm.addEventListener('click', async () => {
                await remove(rec.id);
                toast(`Removed "${rec.title}" from this device.`);
            });
            li.append(open, rm);
            ul.append(li);
        }
        box.append(ul);
        box.append(el('p', 'dl-note', 'Downloads keep the voice you listen with. Other voices, uploads and books that are not downloaded need a connection.'));
    }

    // ── WHEN OFFLINE: explain instead of failing ──
    document.addEventListener('click', e => {
        if (isOnline()) return;
        const add = e.target.closest('[data-sheet-open="add-sheet"]');
        if (add) {
            e.preventDefault(); e.stopImmediatePropagation();
            toast('Adding books needs a connection.');
            return;
        }
        if (e.target.closest('#book-delete')) {
            e.preventDefault(); e.stopImmediatePropagation();
            toast('Deleting a book needs a connection. You can remove its download in Downloads.');
        }
    }, true);

    // ── LOG OUT: this account's downloads leave the device ──
    let logoutForm = null;
    document.addEventListener('submit', e => {
        const form = e.target;
        if (form.id !== 'logout-form') return;
        e.preventDefault();
        if (!isOnline()) { toast('Logging out needs a connection.'); return; }
        logoutForm = form;
        (async () => {
            await ready;
            const books = uid == null ? [] : (await allOf('books', uid).catch(() => []));
            if (!books.length) { leave(); return; }
            const used = books.reduce((n, b) => n + (b.complete ? b.bytes || 0 : b.stored || 0), 0);
            $('logout-text').textContent =
                `Logging out deletes your ${books.length} downloaded ${books.length === 1 ? 'book' : 'books'} (${size(used)}) ` +
                'and your saved details from this device. You can download them again after you log back in.';
            Sheets.open('logout-sheet', form.querySelector('button'));
        })();
    }, true);
    $('logout-confirm').addEventListener('click', leave);

    async function forgetUser() {
        await ready;
        if (uid == null) return;
        const u = uid;
        for (const id of jobs.keys()) cancel(id);
        try {
            for (const rec of await allOf('books', u)) await del('books', [u, rec.id]);
            for (const p of await allOf('progress', u)) await del('progress', [u, p.id]);
            await caches.delete(cacheName(u));
            await del('meta', 'user');
        } catch (e) { /* best effort */ }
        try {
            const prefix = `waudible:ask:${u}:`;
            Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
        } catch (e) { /* not available */ }
        uid = null;
        known.clear();
        tellWorker();
    }

    async function leave() {
        const form = logoutForm;
        if (!form) return;
        $('logout-confirm').disabled = true;
        // Send positions saved offline first (but don't wait long)
        await Promise.race([sync(), new Promise(r => setTimeout(r, 3000))]);
        await forgetUser();
        form.submit();
    }

    // ── AFTER EVERY PAGE LOAD OR SWAP (app.js) ──
    function initPage() {
        confirmAll = false;
        decorateCards();
        renderLists();
    }

    ready.then(() => { renderNetwork(); changed(null); whenOnline(); });
    renderNetwork();

    window.Offline = {
        ready, isOnline, state, download, cancel, remove, removeAll, localBook, playerData,
        saveProgress, markSynced, sync, reconcile, maybeAsk, initPage, updateActions, size,
        user: () => uid,
    };
})();
