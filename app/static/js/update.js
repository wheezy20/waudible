// ─────────────────────────────────────────
// NEW VERSION CHECK
// Every page knows the build it was made with (meta waudible-build), and
// every server response says which build made it (X-Waudible-Build). The
// asset URLs carry that build, so a fresh page load always gets matching
// CSS and JS; this file handles a page that stays open across a deploy
// (the installed app resumed from the background, htmx swaps), and asks
// for a full page load instead of an htmx swap from another build.
//
// A newer build shows up when:
//   - an htmx swap or a JSON request answers with another build, or
//   - the service worker of a new build takes over (controllerchange),
//     which a check on every return to the app (registration.update) and
//     every 30 minutes brings about.
// Then a small bar says "Update available, tap to refresh". With nothing
// playing, no sheet open, no download running and no input for a while
// (or the app in the background), the page reloads by itself.
// ─────────────────────────────────────────
(function () {
    const meta  = document.querySelector('meta[name="waudible-build"]');
    const BUILD = meta ? meta.content : '';
    const bar   = document.getElementById('update-bar');
    if (!BUILD || !bar) return;

    const CHECK_EVERY = 30 * 60 * 1000;
    let newer = null;
    let lastInput = Date.now();

    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input']) {
        window.addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true });
    }

    function found(version) {
        if (!version || version === BUILD || newer) return;
        newer = version;
        bar.hidden = false;
        document.body.classList.add('has-update');
        // Get the new worker (and its cache) in place as soon as possible
        registration().then(reg => reg && reg.update()).catch(() => {});
        maybeReload();
    }

    // ── 1. RESPONSES FROM THE SERVER ──
    // Only pages and JSON: the service worker never keeps those, so they
    // always come from the running server (downloaded media can be old)
    function fromResponse(type, header) {
        if (/html|json/.test(type || '')) found(header);
    }
    document.addEventListener('htmx:afterRequest', e => {
        const xhr = e.detail && e.detail.xhr;
        if (xhr && xhr.status) fromResponse(xhr.getResponseHeader('Content-Type'), xhr.getResponseHeader('X-Waudible-Build'));
    });
    // A page from a newer build swapped into this one would run with this
    // page's older scripts. With nothing playing, htmx requests say which
    // build this page is, and the server answers a different one with
    // HX-Redirect: htmx then loads the page in full instead of swapping.
    // While audio plays the swap goes ahead (the audio carries on) and the
    // bar offers the update.
    document.addEventListener('htmx:configRequest', e => {
        if (!playing()) e.detail.headers['X-Waudible-Build'] = BUILD;
    });
    const realFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const res = await realFetch(...args);
        try {
            if (new URL(res.url, location.href).origin === location.origin) {
                fromResponse(res.headers.get('Content-Type'), res.headers.get('X-Waudible-Build'));
            }
        } catch (e) { /* opaque or odd response: not ours */ }
        return res;
    };

    // ── 2. A NEW SERVICE WORKER TOOK OVER ──
    function registration() {
        return 'serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
    }
    function workerVersion(worker) {
        return new Promise(resolve => {
            if (!worker) return resolve(null);
            const channel = new MessageChannel();
            const timer = setTimeout(() => resolve(null), 3000);
            channel.port1.onmessage = e => { clearTimeout(timer); resolve(e.data && e.data.version); };
            worker.postMessage({ type: 'version' }, [channel.port2]);
        });
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', async () => {
            found(await workerVersion(navigator.serviceWorker.controller));
        });
    }
    function checkNow() {
        if (!navigator.onLine) return;
        registration().then(reg => reg && reg.update()).catch(() => { /* offline */ });
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkNow();
        maybeReload();
    });
    setInterval(checkNow, CHECK_EVERY);

    // ── 3. RELOAD: on a tap, or by itself when nobody would notice ──
    function playing() {
        const a = document.getElementById('audio-player');
        return !!(a && a.getAttribute('src') && !a.paused && !a.ended);
    }
    function idle() {
        if (playing()) return false;
        if (window.Sheets && Sheets.anyOpen()) return false;               // upload form, download choices...
        if (window.Offline && Offline.busy && Offline.busy()) return false;
        if (window.Offline && !Offline.isOnline()) return false;           // the reload would show the offline page
        return document.visibilityState === 'hidden' || Date.now() - lastInput >= Update.idleMs;
    }
    // A page that is already going away (a link, a full load) also turns
    // "hidden": it must not reload itself over the page being opened
    let leaving = false;
    window.addEventListener('beforeunload', () => { leaving = true; });
    window.addEventListener('pageshow', () => { leaving = false; });
    function maybeReload() {
        if (newer && !leaving && idle()) location.reload();
    }
    setInterval(maybeReload, 5000);
    document.getElementById('audio-player') && document.getElementById('audio-player').addEventListener('pause', () => setTimeout(maybeReload, 1000));

    document.getElementById('update-btn').addEventListener('click', () => location.reload());

    window.Update = {
        build: BUILD,
        newer: () => newer,
        idleMs: 60 * 1000,      // no taps or keys for a minute
        check: checkNow,
        maybeReload,
    };
})();
