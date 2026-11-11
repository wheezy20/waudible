// ─────────────────────────────────────────
// PAGE SCRIPTS AND NAVIGATION
// htmx swaps only #app-content, so page scripts run again after every
// swap (initPage) and are cleaned up before the next one (cleanupPage).
// Handlers for the shell (sheets, upload form, book links) are set up
// once, here, with event delegation.
// ─────────────────────────────────────────
(function () {
    const $ = id => document.getElementById(id);
    let page = null;    // { abort: AbortController, timers: [] } for the current content

    // ── TOAST ──
    let toastTimer = null;
    function toast(message) {
        const el = $('toast');
        el.textContent = message;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
    }

    // ── PAGE SET-UP AND CLEAN-UP ──
    function cleanupPage() {
        if (!page) return;
        page.abort.abort();                 // removes listeners added with { signal }
        page.timers.forEach(clearInterval);
        page = null;
    }

    function initPage() {
        cleanupPage();
        const root = document.querySelector('#app-content .page');
        if (!root) return;
        page = { abort: new AbortController(), timers: [] };
        const signal = page.abort.signal;

        // Active item in the bottom bar and the top nav
        const view = root.dataset.view;
        const nav = view === 'downloads' ? 'library' : view;
        document.querySelectorAll('[data-nav]').forEach(a => {
            const on = a.dataset.nav === nav;
            a.classList.toggle('is-active', on);
            if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });

        // Genre filter chips
        root.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const filter = chip.dataset.filter;
                root.querySelectorAll('.chip').forEach(c => {
                    const on = c === chip;
                    c.classList.toggle('is-active', on);
                    c.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                root.querySelectorAll('.shelf').forEach(shelf => {
                    shelf.hidden = !!filter && shelf.dataset.genre !== filter;
                });
            }, { signal });
        });

        // Processing rings on covers: poll every 3 seconds
        root.querySelectorAll('.cover-processing').forEach(ring => {
            const bookId = ring.closest('.book-card').dataset.bookId;
            const timer = setInterval(async () => {
                try {
                    const data = await (await fetch('/status/' + bookId)).json();
                    const pct  = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
                    ring.style.setProperty('--p', pct + '%');
                    ring.setAttribute('aria-label', `Preparing audio, ${data.done} of ${data.total} pages`);
                    if (!data.running) { clearInterval(timer); ring.remove(); }
                } catch (e) { /* try again next tick */ }
            }, 3000);
            page.timers.push(timer);
        });

        // Upload errors from the last request: show them in the Add sheet
        const flash = root.querySelector('.page-flash');
        const alerts = $('add-alerts');
        alerts.innerHTML = '';
        if (flash) {
            alerts.append(...[...flash.children].map(n => n.cloneNode(true)));
            Sheets.open('add-sheet', document.querySelector('.bottom-nav [data-sheet-open], .fab'));
        }

        // Downloaded marks on covers, the Downloads list, the offline page
        Offline.initPage(root);

        // /read/<id>: open that book in the player
        if (root.dataset.openBook) Player.open(root.dataset.openBook);
    }

    // ── NAVIGATION EVENTS (htmx) ──
    document.addEventListener('htmx:beforeSwap', e => {
        if (e.detail.target && e.detail.target.id === 'app-content') cleanupPage();
    });
    document.addEventListener('htmx:afterSwap', e => {
        if (e.detail.target && e.detail.target.id === 'app-content') initPage();
    });
    document.addEventListener('htmx:historyRestore', () => initPage());

    // A failed in-app request: say so, and for a page load fall back to a
    // normal navigation so the error page (or login) shows properly
    document.addEventListener('htmx:responseError', e => {
        const verb = (e.detail.requestConfig && e.detail.requestConfig.verb) || 'get';
        if (verb === 'get' && e.detail.pathInfo) {
            window.location.href = e.detail.pathInfo.requestPath;
        } else {
            toast('Something went wrong. Please try again.');
        }
    });
    // No network for a page change: load it the normal way, so the service
    // worker can show the offline page with the downloaded books
    document.addEventListener('htmx:sendError', e => {
        const verb = (e.detail.requestConfig && e.detail.requestConfig.verb) || 'get';
        if (verb === 'get' && e.detail.pathInfo && !Offline.isOnline()) {
            window.location.href = e.detail.pathInfo.requestPath;
        } else {
            toast("Can't reach WAudible. Check your connection.");
        }
    });

    // ── BOOK LINKS: open in the persistent player ──
    document.addEventListener('click', e => {
        const link = e.target.closest('a[data-open-book]');
        if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        Player.open(link.dataset.openBook);
    });

    // ── BOOK OPTIONS: play, delete with a confirm step ──
    const actionsEl = $('book-actions');
    const confirmEl = $('book-confirm');
    let menuBookId  = null;

    function showActions() { actionsEl.hidden = false; confirmEl.hidden = true; }

    document.addEventListener('click', e => {
        const btn = e.target.closest('.card-more');
        if (!btn) return;
        menuBookId = btn.dataset.bookId;
        $('book-sheet-title').textContent = btn.dataset.title;
        $('confirm-title').textContent = btn.dataset.title;
        $('delete-form').action = '/delete/' + menuBookId;
        const dl = $('book-download');
        dl.dataset.bookId = menuBookId;
        dl.dataset.title  = btn.dataset.title;
        dl.dataset.ready  = btn.dataset.ready;
        Offline.updateActions();
        showActions();
        Sheets.open('book-sheet', btn, { onClose: showActions });
    });
    $('book-open').addEventListener('click', () => {
        Sheets.close({ restoreFocus: false });
        Player.open(menuBookId);
    });
    $('book-delete').addEventListener('click', () => {
        actionsEl.hidden = true;
        confirmEl.hidden = false;
        $('confirm-cancel').focus();
    });
    $('confirm-cancel').addEventListener('click', () => {
        showActions();
        $('book-delete').focus();
    });
    // Delete through htmx (the action is set per book, at submit time).
    // Deleting the book that is loaded in the player stops and clears it.
    $('delete-form').addEventListener('submit', e => {
        e.preventDefault();
        const form = e.currentTarget;
        Player.forget(menuBookId);
        Offline.remove(menuBookId);          // its downloaded copy goes too
        Sheets.close({ restoreFocus: false });
        htmx.ajax('POST', form.getAttribute('action'), { source: form, target: '#app-content', swap: 'innerHTML show:window:top' });
    });

    // ── UPLOAD FORM (in the Add sheet) ──
    const uploadForm = $('upload-form');
    const resetUploadLabels = () => {
        $('pdf-chosen').textContent = 'Choose a PDF';
        $('cover-chosen').textContent = 'JPG, PNG or WebP';
        $('genre-select').disabled = false;
    };
    uploadForm.pdf.addEventListener('change', e =>
        $('pdf-chosen').textContent = e.target.files[0] ? e.target.files[0].name : 'Choose a PDF');
    uploadForm.cover.addEventListener('change', e =>
        $('cover-chosen').textContent = e.target.files[0] ? e.target.files[0].name : 'JPG, PNG or WebP');
    $('custom-genre').addEventListener('input', e => {
        $('genre-select').disabled = e.target.value.trim().length > 0;
    });
    document.addEventListener('htmx:beforeRequest', e => {
        if (e.detail.elt === uploadForm) {
            $('add-alerts').innerHTML = '';
            Sheets.close({ restoreFocus: false });
            toast('Uploading...');
        }
    });
    document.addEventListener('htmx:afterRequest', e => {
        if (e.detail.elt === uploadForm && e.detail.successful) {
            uploadForm.reset();
            resetUploadLabels();
            $('toast').hidden = true;
        }
    });

    // ── START ──
    window.App = { toast, initPage };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPage);
    else initPage();
})();
