// ─────────────────────────────────────────
// OFFLINE LISTENING
// Downloads a finished book, or some of its chapters, to this device and
// keeps it per account:
//   IndexedDB "waudible": books (details, contents, the text of downloaded
//                         pages, file list, which pages are here),
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
    const DEFAULT_CHAPTERS = 3;                 // the current chapter and the next two
    const toast = msg => window.App && App.toast(msg);
    const cacheName = u => `waudible-media-u${u}`;

    // Voice names for display (the mapping comes from tts_engine.VOICE_LABELS
    // through the player's data-voices); ids are what gets stored
    const VOICE_LABELS = (() => {
        try { return JSON.parse(document.getElementById('player-sheet').dataset.voices); } catch (e) { return {}; }
    })();
    window.Voices = {
        name: id => (VOICE_LABELS[id] ? VOICE_LABELS[id].name : id),
        description: id => (VOICE_LABELS[id] ? VOICE_LABELS[id].description : ''),
    };

    function size(bytes) {
        const mb = bytes / 1e6;
        return (mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()) + ' MB';
    }
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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

    // ── BOOK RECORDS ──
    // { uid, id, title, author, genre, pages, voice, cover, toc, files,
    //   textBytes, texts (null for pages not here), have (pages whose audio
    //   is here), pending (pages still to fetch), art (cover and artwork
    //   here), bytes (what is stored), complete (nothing pending), savedAt }
    // Records from before chapter downloads were always the whole book.
    function normalize(rec) {
        if (!rec) return rec;
        if (!Array.isArray(rec.have)) {
            const all = [...Array(rec.pages).keys()];
            rec.have = rec.complete ? all : [];
            rec.pending = rec.complete ? [] : all;
            rec.art = !!rec.complete;
        }
        rec.pending = rec.pending || [];
        if (!Array.isArray(rec.textBytes)) rec.textBytes = (rec.texts || []).map(t => (t ? new Blob([t]).size : 0));
        if (!Array.isArray(rec.texts)) rec.texts = Array(rec.pages).fill(null);
        rec.complete = rec.pending.length === 0;
        return rec;
    }
    const getBook = async (u, id) => normalize(await get('books', [u, Number(id)]));
    const allBooks = async u => (await allOf('books', u)).map(normalize);

    const audioFile = (rec, p) => rec.files.find(f => f.kind === 'audio' && f.page === p);
    const artFiles = rec => rec.files.filter(f => f.kind !== 'audio');
    function storedBytes(rec) {
        let n = rec.art ? artFiles(rec).reduce((t, f) => t + (f.bytes || 0), 0) : 0;
        for (const p of rec.have) n += ((audioFile(rec, p) || {}).bytes || 0) + (rec.textBytes[p] || 0);
        return n;
    }

    // ── WHO IS SIGNED IN ON THIS DEVICE ──
    // Online pages carry the user id; the offline page has none and uses
    // the last account that signed in here (cleared on log out).
    let uid = null, userName = '';
    const known = new Map();    // book id -> summary of this user's record

    async function refreshKnown() {
        known.clear();
        if (uid == null) return;
        try {
            for (const r of await allBooks(uid)) {
                known.set(r.id, { have: r.have.length, pages: r.pages, pending: r.pending.length,
                                  bytes: storedBytes(r), voice: r.voice, title: r.title });
            }
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
        `Not enough space on this device. This needs about ${size(need)} and only ${size(space)} is free. Delete some downloads, choose fewer chapters or free up space, then try again.`;

    // ── THE PLAN: real sizes of every file and page, and the chapters ──
    // From /offline/manifest?texts=0 (no text, just sizes)
    const plans = new Map();
    async function plan(id) {
        id = Number(id);
        if (plans.has(id)) return plans.get(id);
        const r = await fetch(`/offline/manifest/${id}?texts=0`, { headers: { 'Accept': 'application/json' } });
        if (r.status === 409) { const e = new Error('processing'); e.processing = true; throw e; }
        if (!r.ok || r.redirected) throw new Error(r.status);
        const p = await r.json();
        // A page whose audio isn't made yet (another voice) counts as the
        // average of the others, and the total is marked as approximate
        const audio = p.files.filter(f => f.kind === 'audio');
        const sized = audio.filter(f => f.bytes != null);
        const avg = sized.length ? sized.reduce((n, f) => n + f.bytes, 0) / sized.length : 0;
        p.approx = sized.length < audio.length;
        p.pageBytes = [...Array(p.pages).keys()].map(i => {
            const f = audio.find(a => a.page === i);
            return Math.round((f && f.bytes != null ? f.bytes : avg)) + (p.text_bytes[i] || 0);
        });
        p.artBytes = p.files.filter(f => f.kind !== 'audio').reduce((n, f) => n + (f.bytes || 0), 0);
        p.chapters = chaptersOf(p.toc, p.pages);
        plans.set(id, p);
        return p;
    }

    // Chapters as page ranges: each contents entry runs to the next one.
    // Pages before the first entry are "Beginning"; a PDF without real
    // chapter titles gets blocks of 10 pages.
    function chaptersOf(toc, pages) {
        let entries = (toc || []).filter(c => c.page >= 0 && c.page < pages)
                                 .sort((a, b) => a.page - b.page)
                                 .filter((c, i, all) => i === 0 || c.page !== all[i - 1].page);
        const generic = !entries.length || entries.every(c => /^Page \d+$/.test(c.title));
        if (generic) entries = [...Array(Math.ceil(pages / 10)).keys()].map(i => ({ page: i * 10, title: '' }));
        if (entries.length && entries[0].page > 0) entries.unshift({ page: 0, title: 'Beginning' });
        return entries.map((c, i) => {
            const end = (i + 1 < entries.length ? entries[i + 1].page : pages) - 1;
            return { index: i, start: c.page, end, level: c.level || 1,
                     title: generic || !c.title ? `Pages ${c.page + 1} to ${end + 1}` : c.title };
        });
    }
    const chapterAt = (chapters, page) => chapters.find(c => page >= c.start && page <= c.end) || chapters[0];
    const pagesOf = ch => [...Array(ch.end - ch.start + 1).keys()].map(i => ch.start + i);

    function defaultPages(p, page) {
        const first = chapterAt(p.chapters, page || 0);
        return p.chapters.slice(first.index, first.index + DEFAULT_CHAPTERS).flatMap(pagesOf);
    }

    // ── DOWNLOAD ──
    const jobs = new Map();     // book id -> { ctrl, done, total, cancelled, error, pages }
    class DlError extends Error {}

    function state(id) {
        id = Number(id);
        const job = jobs.get(id), k = known.get(id);
        if (job) return { name: 'downloading', pct: job.total ? Math.round(100 * job.done / job.total) : 0, job };
        if (k && k.pending) return { name: 'partial', ...k };       // stopped part way, resumes online
        if (k && k.have) return { name: 'downloaded', whole: k.have === k.pages, ...k };
        return { name: 'none' };
    }

    async function dropFiles(cache, files) {
        for (const f of files || []) await cache.delete(f.url);
    }

    // pages: the pages to add (default: the whole book). Pages already here
    // are skipped, and so are files already in the cache at the right size.
    async function download(id, { pages = null, quiet = false } = {}) {
        id = Number(id);
        await ready;
        if (uid == null || jobs.has(id)) return;
        if (!isOnline()) { toast('Downloading needs a connection.'); return; }
        const me = uid;
        const job = { ctrl: new AbortController(), done: 0, total: 0, cancelled: false, error: '', pages: [] };
        const signal = job.ctrl.signal;
        jobs.set(id, job);
        changed(id);
        persist();
        let rec = null;
        try {
            const res = await fetch(`/offline/manifest/${id}`, { signal, headers: { 'Accept': 'application/json' } });
            if (res.status === 409) throw new DlError('This book is still being prepared. Download it when its audio is ready.');
            if (!res.ok || res.redirected) throw new DlError("The download couldn't start. Please try again.");
            const man = await res.json();

            const cache = await caches.open(cacheName(me));
            rec = await getBook(me, id);
            if (rec && rec.voice !== man.voice) { await dropFiles(cache, rec.files); await del('books', [me, id]); rec = null; }

            const all = [...Array(man.pages).keys()];
            const wanted = (pages || all).filter(p => p >= 0 && p < man.pages);
            const have = new Set(rec ? rec.have : []);
            const todo = [...new Set([...(rec ? rec.pending : []), ...wanted])].filter(p => !have.has(p)).sort((a, b) => a - b);
            job.pages = todo;

            const audioOf = p => man.files.find(f => f.kind === 'audio' && f.page === p);
            const art = man.files.filter(f => f.kind !== 'audio');
            const sized = man.files.filter(f => f.kind === 'audio' && f.bytes != null);
            const avg = sized.length ? sized.reduce((n, f) => n + f.bytes, 0) / sized.length : 0;
            const need = (rec && rec.art ? 0 : art.reduce((n, f) => n + (f.bytes || 0), 0))
                       + todo.reduce((n, p) => n + ((audioOf(p).bytes != null ? audioOf(p).bytes : avg) + man.text_bytes[p]), 0);
            if (!enoughFor(await freeSpace(), need)) throw new DlError(spaceMessage(need, await freeSpace()));

            const texts = rec ? rec.texts : Array(man.pages).fill(null);
            for (const p of todo) texts[p] = man.texts[p];
            rec = { uid: me, id, title: man.title, author: man.author, genre: man.genre, pages: man.pages,
                    voice: man.voice, cover: man.cover, toc: man.toc, files: man.files, textBytes: man.text_bytes,
                    texts, have: [...have].sort((a, b) => a - b), pending: todo, art: rec ? rec.art : false,
                    complete: false, savedAt: Date.now() };
            rec.bytes = storedBytes(rec);
            await put('books', rec);
            await refreshKnown();
            // Start from where the server says the listener is, unless this
            // device has its own position
            if (man.progress && !(await get('progress', [me, id]))) {
                await put('progress', { uid: me, id, page: man.progress.page, speed: man.progress.speed,
                                        voice: man.voice, at: man.progress.at, synced: true });
            }

            const files = [...(rec.art ? [] : art), ...todo.map(audioOf)];
            job.total = files.length;
            let artLeft = rec.art ? 0 : art.length;
            for (const f of files) {
                if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                const cached = await cache.match(f.url);
                if (!(cached && f.bytes != null && Number(cached.headers.get('Content-Length')) === f.bytes)) {
                    const r = await fetch(f.url, { signal, cache: 'no-store' });
                    if (!r.ok || r.redirected) throw new DlError("Part of the book couldn't be downloaded. Please try again.");
                    const blob = await r.blob();
                    // Pages without audio for this voice are made on demand,
                    // so their size is only known now
                    const expected = f.bytes != null ? f.bytes : Number(r.headers.get('Content-Length') || blob.size);
                    if (blob.size !== expected) throw new DlError("A file didn't download completely. Please try again.");
                    f.bytes = blob.size;
                    await cache.put(f.url, new Response(blob, { headers: {
                        'Content-Type': r.headers.get('Content-Type') || blob.type || 'application/octet-stream',
                        'Content-Length': String(blob.size),
                    } }));
                }
                if (f.kind === 'audio') {
                    rec.have.push(f.page);
                    rec.pending = rec.pending.filter(p => p !== f.page);
                } else if (--artLeft === 0) {
                    rec.art = true;
                }
                job.done++;
                if (job.done % 3 === 0) { rec.bytes = storedBytes(rec); await put('books', rec); }   // for resuming
                changed(id);
            }
            rec.have.sort((a, b) => a - b);
            rec.pending = [];
            rec.complete = true;
            rec.art = true;
            rec.savedAt = Date.now();
            rec.bytes = storedBytes(rec);
            await put('books', rec);
            if (!quiet) {
                toast(rec.have.length === rec.pages
                    ? `Downloaded "${man.title}". It plays without a connection.`
                    : `Downloaded ${plural(todo.length, 'page', 'pages')} of "${man.title}". They play without a connection.`);
            }
        } catch (e) {
            if (job.cancelled) {
                // Keep what was here before; drop what this download added
                await dropPages(me, id, job.pages);
                toast('Download cancelled.');
            } else if (e instanceof DlError) {
                job.error = e.message;
                const r = await getBook(me, id).catch(() => null);
                if (r && !r.have.length) await removeFor(me, id);       // nothing useful kept
                toast(e.message);
            } else {
                if (rec) { rec.bytes = storedBytes(rec); await put('books', rec).catch(() => {}); }
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

    // Remove some pages (a chapter); the whole record goes when none are left
    async function dropPages(u, id, pages) {
        const rec = await getBook(u, id);
        if (!rec) return;
        const gone = new Set(pages);
        const cache = await caches.open(cacheName(u));
        for (const p of gone) {
            const f = audioFile(rec, p);
            if (f) await cache.delete(f.url);
            rec.texts[p] = null;
        }
        rec.have = rec.have.filter(p => !gone.has(p));
        rec.pending = rec.pending.filter(p => !gone.has(p));
        rec.complete = !rec.pending.length;
        if (!rec.have.length && !rec.pending.length) { await removeFor(u, id); return; }
        rec.bytes = storedBytes(rec);
        await put('books', rec);
    }

    async function removePages(id, pages) {
        id = Number(id);
        await ready;
        if (uid == null) return;
        if (jobs.has(id)) cancel(id);
        await dropPages(uid, id, pages);
        await refreshKnown();
        changed(id);
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
        for (const rec of await allBooks(uid)) {
            if (rec.pending.length && !jobs.has(rec.id)) download(rec.id, { pages: rec.pending, quiet: true });
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
    // A copy with at least one page here (the whole book or some chapters)
    async function localBook(id) {
        await ready;
        if (uid == null) return null;
        try {
            const r = await getBook(uid, id);
            return r && r.have.length ? r : null;
        } catch (e) { return null; }
    }

    // The nearest page here to `page`, looking forward first
    function nearestHere(rec, page) {
        const have = rec.have;
        return have.find(p => p >= page) ?? have[have.length - 1];
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
        if (!rec.have.includes(data.page)) data.page = nearestHere(rec, data.page);
        data.voice = rec.voice;
        data.cover = rec.cover;
        data.local = rec;
        return data;
    }

    // ── UI: cards and menu items ──
    function changed(id) {
        decorateCards();
        updateActions();
        if (sheet && (id == null || sheet.id === id)) renderSheet();
        renderLists();
    }

    function decorateCards(root = document) {
        root.querySelectorAll('.book-card[data-book-id]').forEach(card => {
            const s = state(card.dataset.bookId);
            card.classList.toggle('is-downloaded', s.name === 'downloaded' || (s.name === 'partial' && s.have > 0));
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
            else if (s.name === 'downloaded') text = s.whole ? 'Downloaded to this device' : `Downloaded: ${s.have} of ${s.pages} pages`;
            else if (btn.dataset.ready !== '1') { text = 'Download (when the audio is ready)'; disabled = true; }
            else if (s.name === 'partial') { text = 'Resume download'; disabled = !isOnline(); }
            else if (!isOnline()) { text = 'Download (needs a connection)'; disabled = true; }
            label.textContent = text;
            btn.disabled = disabled;
            btn.classList.toggle('is-done', s.name === 'downloaded');
        });
    }

    // ── THE DOWNLOAD SHEET: what to download, with real sizes ──
    // sheet: { id, title, mode, picked: Set of chapter indexes, from, to }
    let sheet = null;

    function sheetPages(p, rec) {
        const here = new Set(rec ? rec.have : []);
        let pages = [];
        if (sheet.mode === 'all') pages = [...Array(p.pages).keys()];
        else if (sheet.mode === 'chapters') pages = p.chapters.filter(c => sheet.picked.has(c.index)).flatMap(pagesOf);
        else if (sheet.from >= 1 && sheet.to >= sheet.from && sheet.to <= p.pages) {
            pages = [...Array(sheet.to - sheet.from + 1).keys()].map(i => sheet.from - 1 + i);
        }
        return pages.filter(x => !here.has(x));
    }

    function renderModes() {
        document.querySelectorAll('.dl-mode').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === sheet.mode)));
        $('dl-chapters').hidden = sheet.mode !== 'chapters';
        $('dl-range').hidden = sheet.mode !== 'range';
        $('dl-all-note').hidden = sheet.mode !== 'all';
    }

    function renderChapterList(p, rec) {
        const here = new Set(rec ? rec.have : []);
        const box = $('dl-chapters');
        box.replaceChildren();
        for (const ch of p.chapters) {
            const pages = pagesOf(ch);
            const got = pages.filter(x => here.has(x)).length;
            const bytes = pages.filter(x => !here.has(x)).reduce((n, x) => n + p.pageBytes[x], 0);
            const row = el('label', 'dl-chapter' + (ch.level > 1 ? ' dl-sub' : '') + (got === pages.length ? ' is-here' : ''));
            row.dataset.chapter = ch.index;
            row.dataset.bytes = bytes;
            const box2 = el('input');
            box2.type = 'checkbox';
            box2.checked = got === pages.length || sheet.picked.has(ch.index);
            box2.disabled = got === pages.length;
            box2.addEventListener('change', () => {
                if (box2.checked) sheet.picked.add(ch.index); else sheet.picked.delete(ch.index);
                renderTotal();
            });
            const text = el('span', 'dl-chapter-text');
            text.append(el('span', 'dl-chapter-title', ch.title));
            const range = ch.start === ch.end ? `p. ${ch.start + 1}` : `p. ${ch.start + 1} to ${ch.end + 1}`;
            text.append(el('span', 'dl-chapter-meta', got === pages.length ? `${range}, on this device`
                : got ? `${range}, ${got} of ${pages.length} pages here, ${size(bytes)} more` : `${range}, ${size(bytes)}`));
            row.append(box2, text);
            box.append(row);
        }
    }

    function renderTotal() {
        const p = sheet.plan, rec = sheet.rec;
        if (!p) return;
        const pages = sheetPages(p, rec);
        const bytes = pages.reduce((n, x) => n + p.pageBytes[x], 0) + (rec && rec.art ? 0 : (pages.length ? p.artBytes : 0));
        sheet.pages = pages;
        sheet.bytes = bytes;
        const total = $('dl-total'), start = $('dl-start'), err = $('dl-error');
        total.dataset.bytes = bytes;
        total.dataset.pages = pages.length;
        const about = p.approx ? 'about ' : '';
        if (sheet.mode === 'chapters') {
            const n = [...sheet.picked].filter(i => sheetPages({ ...p, chapters: [p.chapters[i]] }, rec).length).length;
            total.textContent = pages.length
                ? `${plural(n, 'chapter', 'chapters')}, ${plural(pages.length, 'page', 'pages')}, ${about}${size(bytes)}`
                : 'Choose one or more chapters.';
        } else if (sheet.mode === 'range') {
            total.textContent = pages.length ? `${plural(pages.length, 'page', 'pages')}, ${about}${size(bytes)}`
                : sheet.from && sheet.to ? `Enter pages from 1 to ${p.pages}, not already on this device.` : `Enter pages from 1 to ${p.pages}.`;
        } else {
            total.textContent = pages.length ? `${plural(pages.length, 'page', 'pages')}, ${about}${size(bytes)}`
                : 'The whole book is already on this device.';
        }
        start.textContent = pages.length ? `Download ${size(bytes)}` : 'Download';
        if (!isOnline()) { err.textContent = 'Downloading needs a connection.'; start.disabled = true; return; }
        start.disabled = !pages.length || sheet.noSpace;
        if (pages.length && sheet.space !== undefined && !enoughFor(sheet.space, bytes)) {
            err.textContent = spaceMessage(bytes, sheet.space);
            start.disabled = true;
        } else if (!lastError.get(sheet.id)) {
            err.textContent = '';
        }
    }

    function setSheetState(name) {
        for (const n of ['confirm', 'progress']) $('dl-' + n).hidden = n !== name;
    }

    async function renderSheet() {
        if (!sheet) return;
        const id = sheet.id, s = state(id);
        $('dl-book').textContent = sheet.title;
        if (s.name === 'downloading') {
            setSheetState('progress');
            $('dl-ring').style.setProperty('--p', s.pct + '%');
            $('dl-pct').textContent = s.pct + '%';
            $('dl-progress-text').textContent = s.job.total
                ? `Downloading page audio and text, ${s.job.done} of ${s.job.total} files.` : 'Starting...';
            return;
        }
        setSheetState('confirm');
        const err = $('dl-error');
        err.textContent = lastError.get(id) || '';
        $('dl-start').disabled = true;
        const rec = await getBook(uid, id).catch(() => null);
        if (!sheet || sheet.id !== id) return;
        sheet.rec = rec;
        const have = $('dl-have');
        have.hidden = !(rec && rec.have.length);
        if (rec && rec.have.length) {
            have.textContent = rec.have.length === rec.pages
                ? `The whole book is on this device (${size(storedBytes(rec))}).`
                : `${rec.have.length} of ${rec.pages} pages are on this device (${size(storedBytes(rec))}). Choose more to add.`;
        }
        $('dl-remove').hidden = !(rec && (rec.have.length || rec.pending.length));
        let p = sheet.plan;
        if (!p) {
            if (!isOnline()) {
                $('dl-chapters').replaceChildren();
                $('dl-total').textContent = '';
                err.textContent = rec ? 'Adding chapters needs a connection.' : 'Downloading needs a connection.';
                return;
            }
            $('dl-total').textContent = 'Checking sizes...';
            try { p = await plan(id); } catch (x) {
                err.textContent = x.processing ? 'This book is still being prepared. Download it when its audio is ready.'
                                               : "Couldn't check the sizes. Please try again.";
                $('dl-total').textContent = '';
                return;
            }
            if (!sheet || sheet.id !== id) return;
            sheet.plan = p;
            sheet.space = await freeSpace();
            if (!sheet.picked) {
                const here = new Set(rec ? rec.have : []);
                const current = window.Player && Player.bookId() === id ? Player.currentPage() : (p.progress ? p.progress.page : 0);
                // The chapter they are on and the next two, skipping chapters already here
                const start = chapterAt(p.chapters, current).index;
                const fresh = p.chapters.filter(c => c.index >= start && pagesOf(c).some(x => !here.has(x)));
                sheet.picked = new Set(fresh.slice(0, DEFAULT_CHAPTERS).map(c => c.index));
                sheet.from = current + 1;
                sheet.to = Math.min(p.pages, current + 10);
                $('dl-from').value = sheet.from; $('dl-to').value = sheet.to;
                $('dl-from').max = $('dl-to').max = p.pages;
            }
        }
        $('dl-voice-note').textContent =
            `Only the voice you listen with (${Voices.name(p.voice)}) is downloaded. Other voices need a connection.`;
        $('dl-all-note').textContent = `All ${plural(p.pages, 'page', 'pages')} of the book.`;
        renderModes();
        renderChapterList(p, rec);
        renderTotal();
    }

    function openSheet(id, title, opener) {
        sheet = { id: Number(id), title: title || '', mode: 'chapters', picked: null, plan: null };
        lastError.delete(sheet.id);
        renderSheet();
        Sheets.open('download-sheet', opener, { onClose: () => { sheet = null; } });
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-download-action], [data-download-open]');
        if (!btn || btn.disabled) return;
        openSheet(btn.dataset.bookId, btn.dataset.title, btn);
    });
    document.querySelectorAll('.dl-mode').forEach(b => b.addEventListener('click', () => {
        if (!sheet) return;
        sheet.mode = b.dataset.mode;
        renderModes();
        renderTotal();
    }));
    for (const f of ['dl-from', 'dl-to']) {
        $(f).addEventListener('input', () => {
            if (!sheet) return;
            sheet.from = parseInt($('dl-from').value);
            sheet.to = parseInt($('dl-to').value);
            renderTotal();
        });
    }
    $('dl-start').addEventListener('click', () => {
        if (!sheet || !sheet.pages || !sheet.pages.length) return;
        lastError.delete(sheet.id);
        download(sheet.id, { pages: sheet.pages });
        renderSheet();
    });
    $('dl-cancel').addEventListener('click', () => { if (sheet) cancel(sheet.id); });
    $('dl-remove').addEventListener('click', async () => {
        if (!sheet) return;
        const id = sheet.id;
        Sheets.close();
        await remove(id);
        toast('Removed from this device.');
    });

    // ── THE SUGGESTION: download a few chapters instead of streaming ──
    const askKey = id => `waudible:ask:${uid}:${id}`;
    const askedNow = new Set();     // shown once per visit at most
    let ask = null, answered = false;

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
        let p;
        try { p = await plan(id); } catch (x) { return; }
        const current = window.Player && Player.bookId() === id ? Player.currentPage() : book.page;
        const pages = defaultPages(p, current);
        const bytes = pages.reduce((n, x) => n + p.pageBytes[x], 0) + p.artBytes;
        if (!enoughFor(await freeSpace(), bytes)) return;
        // Still the book on screen, with nothing else open
        if (!window.Player || Player.bookId() !== id || !Player.isExpanded() || Sheets.anyOpen()) return;
        const chapters = new Set(pages.map(x => chapterAt(p.chapters, x).index)).size;
        askedNow.add(id);
        ask = { id, pages };
        answered = false;
        $('ask-size').textContent = (p.approx ? 'about ' : '') + size(bytes);
        $('ask-size').dataset.bytes = bytes;
        $('ask-what').textContent = pages.length === p.pages ? 'the whole book'
            : chapters === 1 ? 'this chapter' : `this chapter and the next ${chapters === 2 ? 'one' : 'two'}`;
        Sheets.open('ask-sheet', null, { onClose: () => { if (!answered) remember(id, 'later'); ask = null; } });
    }

    $('ask-download').addEventListener('click', () => {
        const a = ask; answered = true;
        Sheets.close();
        toast('Downloading. Follow it in Library, Downloads.');
        download(a.id, { pages: a.pages });
    });
    $('ask-later').addEventListener('click', () => { remember(ask.id, 'later'); answered = true; Sheets.close(); });
    $('ask-never').addEventListener('click', () => { remember(ask.id, 'never'); answered = true; Sheets.close(); });

    // ── DOWNLOADS SCREEN AND THE OFFLINE PAGE ──
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    const TRASH = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/></svg>';
    const CHEVRON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

    let confirmAll = false;
    const expanded = new Set();     // books whose chapters are shown

    function bookMeta(rec, s) {
        if (s.name === 'downloading') return `Downloading ${s.pct}%`;
        const bytes = size(storedBytes(rec));
        const pages = rec.have.length === rec.pages ? `Whole book, ${bytes}` : `${rec.have.length} of ${rec.pages} pages, ${bytes}`;
        if (rec.pending.length) return `${pages}. ${isOnline() ? 'More coming' : 'More comes when you are back online'}.`;
        return `${pages}, voice ${Voices.name(rec.voice)}`;
    }

    function chapterRows(rec, offlineView) {
        const here = new Set(rec.have);
        const ul = el('ul', 'dl-chapter-list');
        for (const ch of chaptersOf(rec.toc, rec.pages)) {
            const pages = pagesOf(ch);
            const got = pages.filter(x => here.has(x));
            const li = el('li', 'dl-ch' + (got.length === pages.length ? ' is-here' : got.length ? ' is-part' : ''));
            li.dataset.chapter = ch.index;
            const mark = el('span', 'dl-ch-mark');
            mark.setAttribute('aria-hidden', 'true');
            const text = el('span', 'dl-ch-text');
            text.append(el('span', 'dl-ch-title', ch.title));
            text.append(el('span', 'dl-ch-meta', got.length === pages.length ? 'On this device'
                : got.length ? `${got.length} of ${pages.length} pages here` : 'Not downloaded'));
            li.append(mark, text);
            if (got.length) {
                const rm = el('button', 'icon-btn dl-ch-delete');
                rm.type = 'button';
                rm.innerHTML = TRASH;
                rm.setAttribute('aria-label', `Delete ${ch.title} from this device`);
                rm.addEventListener('click', async () => {
                    await removePages(rec.id, got);
                    toast(`Removed ${ch.title} from this device.`);
                });
                li.append(rm);
            }
            ul.append(li);
        }
        const wrap = el('div', 'dl-details');
        wrap.id = `dl-details-${rec.id}`;
        wrap.append(ul);
        if (!offlineView && rec.have.length < rec.pages) {
            const add = el('button', 'btn btn-ghost btn-pill btn-sm dl-add', 'Add chapters');
            add.type = 'button';
            add.dataset.downloadOpen = '';
            add.dataset.bookId = rec.id;
            add.dataset.title = rec.title;
            wrap.append(add);
        }
        return wrap;
    }

    async function renderLists() {
        const box = document.querySelector('#app-content #downloads');
        const link = $('downloads-link-sub');
        if (!box && !link) return;
        await ready;
        let books = [];
        try { books = uid == null ? [] : await allBooks(uid); } catch (e) { /* none */ }
        books.sort((a, b) => b.savedAt - a.savedAt);
        const usable = books.filter(b => b.have.length);
        const used = books.reduce((n, b) => n + storedBytes(b), 0);
        if (link) {
            link.textContent = usable.length
                ? `${plural(usable.length, 'book', 'books')}, ${size(used)} on this device`
                : 'Listen without a connection';
        }
        if (!box) return;
        const offlineView = !!box.closest('[data-view="offline"]');
        const list = offlineView ? usable : books;
        // Keep the place when the list is redrawn during a download
        const focusId = document.activeElement && document.activeElement.id;
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
        summary.append(el('p', 'downloads-total', `${plural(usable.length, 'book', 'books')}, ${size(used)} used on this device`));
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
            const head = el('div', 'dl-row');
            const open = el('a', 'dl-open');
            open.href = `/read/${rec.id}`;
            if (rec.have.length) open.dataset.openBook = rec.id;
            open.setAttribute('hx-boost', 'false');
            open.setAttribute('aria-label', `Play ${rec.title}`);
            const img = el('img', 'dl-cover');
            img.src = rec.cover;
            img.alt = '';
            const info = el('span', 'dl-info');
            info.append(el('span', 'dl-title', rec.title));
            info.append(el('span', 'dl-meta', bookMeta(rec, s)));
            open.append(img, info);
            const toggle = el('button', 'icon-btn dl-toggle');
            toggle.type = 'button';
            toggle.id = `dl-toggle-${rec.id}`;
            toggle.innerHTML = CHEVRON;
            toggle.setAttribute('aria-label', `Chapters of ${rec.title}`);
            toggle.setAttribute('aria-expanded', String(expanded.has(rec.id)));
            toggle.setAttribute('aria-controls', `dl-details-${rec.id}`);
            toggle.addEventListener('click', () => {
                if (expanded.has(rec.id)) expanded.delete(rec.id); else expanded.add(rec.id);
                renderLists();
            });
            const rm = el('button', 'icon-btn dl-delete');
            rm.type = 'button';
            rm.setAttribute('aria-label', `Delete the download of ${rec.title}`);
            rm.innerHTML = TRASH;
            rm.addEventListener('click', async () => {
                await remove(rec.id);
                toast(`Removed "${rec.title}" from this device.`);
            });
            head.append(open, toggle, rm);
            li.append(head);
            if (expanded.has(rec.id)) li.append(chapterRows(rec, offlineView));
            ul.append(li);
        }
        box.append(ul);
        box.append(el('p', 'dl-note', 'Downloads keep the voice you listen with. Other voices, uploads and pages that are not downloaded need a connection.'));
        updateActions();
        if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
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
            const books = uid == null ? [] : (await allBooks(uid).catch(() => []));
            if (!books.length) { leave(); return; }
            const used = books.reduce((n, b) => n + storedBytes(b), 0);
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
        ready, isOnline, state, download, cancel, remove, removePages, removeAll, localBook, playerData,
        saveProgress, markSynced, sync, reconcile, maybeAsk, initPage, updateActions, size, chaptersOf,
        user: () => uid,
        busy: () => jobs.size > 0,          // a download is running (the update check waits)
    };
})();
