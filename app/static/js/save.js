// ─────────────────────────────────────────
// SAVE TO DEVICE
// Proper MP3 files in the phone's Downloads folder, outside the app: a
// chapter, several chapters (one file each), a page range or the whole
// book as one file. The server joins the page MP3s (app/export.py).
//
// Each file is checked first (/export/<id>/check), so a problem shows
// here instead of as a failed download, then saved with a normal link
// download (/export/<id>/file), which Android's download manager handles
// and shows in its notifications. Several files go one after another.
// Opened from the book menu, a chapter in the contents drawer, or a
// chapter on the Downloads screen ([data-save-open]).
// ─────────────────────────────────────────
(function () {
    const $ = id => document.getElementById(id);
    const GAP_MS   = 2500;      // between files, so each build finishes first
    const BUSY_TRIES = 6;

    let sheet = null;           // { id, title, page, info, mode, picked, from, to }
    let run   = null;           // { stop } while files are being saved

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const size = bytes => Offline.size(bytes);
    const voiceName = id => (window.Voices ? Voices.name(id) : id);

    function show(name, message) {
        $('save-form').hidden = name !== 'form';
        $('save-progress').hidden = name !== 'progress';
        $('save-message').hidden = name !== 'message';
        if (name === 'message') $('save-message').textContent = message;
    }

    // ── OPEN ──
    async function open(id, title, { page = null, opener = null } = {}) {
        id = Number(id);
        if (run && sheet && sheet.id !== id) {
            App.toast('Files from another book are still being saved.');
            return;
        }
        if (!(sheet && sheet.id === id && run)) sheet = { id, title, page: page === null || page === '' ? null : Number(page) };
        $('save-book').textContent = title || '';
        Sheets.open('save-sheet', opener);
        if (run) { show('progress'); return; }
        if (!Offline.isOnline()) {
            show('message', "Saving to your device needs a connection. Try again when you're online.");
            return;
        }
        show('message', 'Loading...');
        try {
            const res = await fetch(`/export/${id}/info`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.status);
            if (!sheet || sheet.id !== id) return;
            sheet.info = data;
        } catch (e) {
            show('message', Offline.isOnline() ? "Couldn't load this book's chapters. Please try again."
                                               : "Saving to your device needs a connection. Try again when you're online.");
            return;
        }
        const chs = sheet.info.chapters;
        const at = sheet.page === null ? null : chs.find(c => sheet.page >= c.start && sheet.page <= c.end);
        sheet.mode = 'chapters';
        sheet.picked = new Set(at ? [at.index] : chs.filter(c => c.ready).map(c => c.index));
        sheet.from = at ? at.start + 1 : 1;
        sheet.to = at ? at.end + 1 : sheet.info.pages;
        $('save-from').value = sheet.from;
        $('save-to').value = sheet.to;
        $('save-from').max = $('save-to').max = sheet.info.pages;
        renderChapters();
        render();
        show('form');
        const row = at && $('save-chapters').querySelector(`[data-chapter="${at.index}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
    }

    function renderChapters() {
        const box = $('save-chapters'), v = voiceName(sheet.info.voice);
        box.replaceChildren();
        for (const ch of sheet.info.chapters) {
            const row = document.createElement('label');
            row.className = 'dl-chapter' + (ch.ready ? '' : ' is-unready');
            row.dataset.chapter = ch.index;
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = sheet.picked.has(ch.index);
            input.disabled = !ch.ready;
            input.addEventListener('change', () => {
                if (input.checked) sheet.picked.add(ch.index); else sheet.picked.delete(ch.index);
                render();
            });
            const text = document.createElement('span');
            text.className = 'dl-chapter-text';
            const t = document.createElement('span');
            t.className = 'dl-chapter-title';
            t.textContent = ch.title;
            const m = document.createElement('span');
            m.className = 'dl-chapter-meta';
            const range = ch.start === ch.end ? `p. ${ch.start + 1}` : `p. ${ch.start + 1} to ${ch.end + 1}`;
            m.textContent = ch.ready ? `${range}, ${size(ch.bytes)}` : `${range}, not ready in ${v} yet`;
            text.append(t, m);
            row.append(input, text);
            box.append(row);
        }
    }

    // What the Save button would save: [{ query, label, bytes }]
    function jobs() {
        const info = sheet.info;
        if (sheet.mode === 'chapters') {
            return info.chapters.filter(c => sheet.picked.has(c.index) && c.ready)
                .map(c => ({ query: `chapter=${c.index}`, label: c.title, bytes: c.bytes }));
        }
        if (sheet.mode === 'whole') {
            return info.whole.ready ? [{ query: 'whole=1', label: 'the whole book', bytes: info.whole.bytes }] : [];
        }
        const a = sheet.from, b = sheet.to;
        if (!(a >= 1 && b >= a && b <= info.pages)) return [];
        const bytes = info.page_bytes.slice(a - 1, b);
        if (bytes.some(x => x === null)) return [];
        return [{ query: `pages=${a}-${b}`, label: a === b ? `page ${a}` : `pages ${a} to ${b}`, bytes: bytes.reduce((n, x) => n + x, 0) }];
    }

    function render() {
        const info = sheet.info, v = voiceName(info.voice);
        document.querySelectorAll('.save-mode').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === sheet.mode)));
        $('save-chapters').hidden = sheet.mode !== 'chapters';
        $('save-range').hidden = sheet.mode !== 'range';
        $('save-whole-note').hidden = sheet.mode !== 'whole';
        $('save-whole-note').textContent = `The whole book as one file, with a marker at each chapter: ${info.whole.name}`;
        const list = jobs(), bytes = list.reduce((n, j) => n + j.bytes, 0);
        const total = $('save-total'), err = $('save-error'), start = $('save-start');
        err.textContent = '';
        if (list.length) {
            total.textContent = `${plural(list.length, 'file', 'files')}, ${size(bytes)}`;
        } else if (sheet.mode === 'chapters') {
            total.textContent = info.chapters.some(c => c.ready) ? 'Choose one or more chapters.' : '';
            if (!info.chapters.some(c => c.ready)) err.textContent = `No chapter is ready in ${v} yet.`;
        } else if (sheet.mode === 'whole') {
            total.textContent = '';
            err.textContent = `The whole book isn't ready in ${v} yet: ${info.ready_pages} of ${info.pages} pages have audio.`;
        } else {
            const a = sheet.from, b = sheet.to;
            total.textContent = '';
            err.textContent = a >= 1 && b >= a && b <= info.pages
                ? `Some of these pages aren't ready in ${v} yet.` : `Enter pages from 1 to ${info.pages}.`;
        }
        $('save-voice-note').textContent = `In ${v}, the voice you listen with.`;
        start.textContent = list.length > 1 ? `Save ${list.length} files` : 'Save';
        start.disabled = !list.length;
        total.dataset.files = list.length;
        total.dataset.bytes = bytes;
    }

    document.querySelectorAll('.save-mode').forEach(b => b.addEventListener('click', () => {
        if (!sheet || !sheet.info) return;
        sheet.mode = b.dataset.mode;
        render();
    }));
    for (const id of ['save-from', 'save-to']) {
        $(id).addEventListener('input', () => {
            sheet.from = parseInt($('save-from').value, 10);
            sheet.to = parseInt($('save-to').value, 10);
            render();
        });
    }

    // ── SAVE: check each file, then hand it to the browser's downloads ──
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function check(id, query) {
        for (let attempt = 1; ; attempt++) {
            let res;
            try {
                res = await fetch(`/export/${id}/check?${query}`);
            } catch (e) {
                return { error: Offline.isOnline() ? "Couldn't reach the server. Please try again."
                                                   : 'The connection dropped. Saving needs a connection.' };
            }
            if (res.ok) return res.json();
            const data = await res.json().catch(() => ({}));
            if (res.status === 503 && attempt < BUSY_TRIES) { await sleep(3000); continue; }
            if (res.status === 429) return { error: "You've saved a lot of files in the last hour. Please wait a while and try again." };
            return { error: data.error || "This file couldn't be saved. Please try again." };
        }
    }

    function handOver(id, query) {
        const a = document.createElement('a');
        a.href = `/export/${id}/file?${query}`;
        a.download = '';            // the server's filename
        a.hidden = true;
        document.body.append(a);
        a.click();
        a.remove();
    }

    async function start() {
        const list = jobs();
        if (!list.length || run) return;
        const id = sheet.id;
        run = { stop: false };
        show('progress');
        $('save-progress-error').textContent = '';
        $('save-stop').hidden = list.length < 2;
        const text = $('save-progress-text'), fill = $('save-bar-fill');
        let done = 0;
        for (const job of list) {
            if (run.stop) break;
            text.textContent = list.length > 1 ? `Saving ${done + 1} of ${list.length}: ${job.label}` : `Saving ${job.label}...`;
            fill.style.width = `${Math.round(100 * done / list.length)}%`;
            const ok = await check(id, job.query);
            if (ok.error) {
                $('save-progress-error').textContent = ok.error;
                break;
            }
            handOver(id, job.query);
            done++;
            fill.style.width = `${Math.round(100 * done / list.length)}%`;
            if (done < list.length) await sleep(GAP_MS);
        }
        const stopped = run.stop;
        run = null;
        $('save-stop').hidden = true;
        if (done === list.length) {
            text.textContent = list.length > 1
                ? `All ${list.length} files are on their way to your Downloads folder.`
                : `${list[0].label.charAt(0).toUpperCase() + list[0].label.slice(1)} is on its way to your Downloads folder.`;
        } else if (stopped) {
            text.textContent = `Stopped after ${plural(done, 'file', 'files')}.`;
        } else {
            text.textContent = done ? `Saved ${done} of ${list.length} files, then stopped:` : "This couldn't be saved:";
        }
    }

    $('save-start').addEventListener('click', start);
    $('save-stop').addEventListener('click', () => { if (run) run.stop = true; });

    // ── WHERE IT OPENS FROM ──
    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-save-open]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (btn.closest('#book-sheet')) Sheets.close({ restoreFocus: false });
        open(btn.dataset.bookId, btn.dataset.title, { page: btn.dataset.page ?? null, opener: btn });
    });
    // The book menu's button follows the book it was opened for
    document.addEventListener('click', e => {
        const more = e.target.closest('.card-more');
        if (!more) return;
        const btn = $('book-save');
        btn.dataset.bookId = more.dataset.bookId;
        btn.dataset.title = more.dataset.title;
    }, true);

    window.Save = { open, running: () => !!run };
})();
