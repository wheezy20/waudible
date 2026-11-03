// ─────────────────────────────────────────
// PERSISTENT PLAYER
// Lives in the page shell (base.html) and is set up exactly once, so
// audio keeps playing while #app-content changes. One <audio> element
// for the whole session; books are loaded into it with Player.open(id).
// ─────────────────────────────────────────
(function () {
    const $ = id => document.getElementById(id);

    const sheetEl   = $('player-sheet');
    const audioEl   = $('audio-player');
    const pageNumEl = $('page-number');
    const subEl     = $('player-sub');
    const statusEl  = $('player-status');
    const textBoxEl = $('text-box');
    const voiceEl   = $('voice');
    const tocList   = $('toc-list');
    const seekEl    = $('seek');
    const playBtn   = $('play-btn');
    const speedBtn  = $('speed-btn');
    const miniEl    = $('mini-player');
    const miniPlay  = $('mini-play');
    const tocSidebar = $('toc-sidebar');
    const tocOpenBtn = $('toc-open-btn');
    const SPEEDS    = JSON.parse(sheetEl.dataset.speeds);

    // Current book (from /player/<id>) and its state
    let book        = null;
    let currentPage = 0;
    let speed       = 1;
    let readyPages  = new Set();
    let tocChapters = [];
    let openToken   = 0;
    let pendingId   = null;     // book being opened (waiting for the server)
    let readinessTimer = null;

    const csrf = () => document.querySelector('meta[name="csrf-token"]').content;

    // ── STATUS (loading / generating), shown under the seek bar ──
    function setStatus(text, busy = false) {
        statusEl.textContent = text || '';
        statusEl.classList.toggle('busy', !!busy && !!text);
    }

    // ── SPEED: audio is generated at 1.0, the browser changes speed ──
    audioEl.preservesPitch = true;

    function speedLabel(s) { return (Number.isInteger(s) ? s : s.toString()) + 'x'; }

    function setPlaybackRate() {
        // load() resets playbackRate to defaultPlaybackRate, so set both
        // to keep the speed between pages
        audioEl.defaultPlaybackRate = speed;
        audioEl.playbackRate        = speed;
        speedBtn.textContent = speedLabel(speed);
        speedBtn.setAttribute('aria-label', `Playback speed ${speedLabel(speed)}, tap to change`);
    }

    speedBtn.addEventListener('click', () => {
        const i = SPEEDS.indexOf(speed);
        speed = SPEEDS[(i + 1) % SPEEDS.length];
        setPlaybackRate();
        saveProgress();
    });

    // ── OPEN A BOOK ──
    async function open(id, { expand = true, autoplay = true } = {}) {
        id = Number(id);
        if (book && book.id === id) {        // already loaded: just show it
            if (expand) expandSheet();
            return;
        }
        const token = ++openToken;
        pendingId = id;
        if (book) {
            await saveProgress();            // remember where the old book was
        }
        audioEl.pause();

        let data;
        try {
            const res = await fetch(`/player/${id}`, { headers: { 'Accept': 'application/json' } });
            if (res.redirected && new URL(res.url).pathname === '/login') {
                window.location.href = res.url;   // session ended: full page login
                return;
            }
            if (!res.ok) throw new Error(res.status);
            data = await res.json();
        } catch (e) {
            App.toast("That book couldn't be opened.");
            return;
        }
        if (token !== openToken) return;     // another book opened, or the player was cleared
        pendingId = null;

        load(data);
        if (expand) expandSheet();
        loadPage(data.page, autoplay);
    }

    function load(data) {
        book        = data;
        currentPage = data.page;
        speed       = data.speed;
        voiceEl.value = data.voice;
        readyPages  = new Set();
        tocChapters = [];
        preloadedKey = null;

        $('player-title').textContent  = data.title;
        $('player-author').textContent = data.author;
        $('player-genre').textContent  = data.genre;
        $('page-total').textContent    = data.pages;
        $('jump-max').textContent      = data.pages;
        $('jump-input').max            = data.pages;
        $('mini-title').textContent    = data.title;
        $('cover-img').src = data.cover;
        $('mini-cover').src = data.cover;
        miniEl.hidden = false;
        document.body.classList.add('has-mini');
        setPlaybackRate();

        tocList.innerHTML = '<p class="toc-loading">Loading...</p>';
        loadToc(data.id);

        // Readiness dots keep updating while the book is still processing
        clearInterval(readinessTimer);
        readinessTimer = setInterval(async () => {
            if (!book || book.id !== data.id) return;
            await updateTocReadiness();
            try {
                const s = await (await fetch(`/status/${data.id}`)).json();
                if (!s.running) clearInterval(readinessTimer);
            } catch (e) { /* try again next tick */ }
        }, 5000);
    }

    // ── CLEAR (book deleted) ──
    function clear() {
        openToken++;                        // cancels a book that is still opening
        pendingId = null;
        clearInterval(readinessTimer);
        clearSleep();
        collapseSheet();
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
        preloadEl.removeAttribute('src');
        preloadedKey = null;
        book = null;
        miniEl.hidden = true;
        document.body.classList.remove('has-mini');
        showPlaying(false);
        if (mediaSession) {
            mediaSession.metadata = null;
            mediaSession.playbackState = 'none';
        }
    }

    // ── LOAD PAGE ──
    function loadPage(page, autoplay = true) {
        if (!book || page < 0 || page >= book.pages) return;
        currentPage = page;
        pageNumEl.textContent = currentPage + 1;
        $('text-page').textContent = currentPage + 1;
        $('btn-prev').disabled = currentPage === 0;
        $('btn-next').disabled = currentPage === book.pages - 1;

        highlightTocItem(currentPage);
        updateSubtitle();

        if (readyPages.has(currentPage)) setStatus('Loading', true);
        else setStatus('Generating audio', true);

        // Same audio element for the whole session (keeps the lock-screen
        // player alive). Setting src starts loading; play() right away.
        audioEl.src = `/audio/${book.id}/${currentPage}?voice=${voiceEl.value}`;
        setPlaybackRate();
        updateMediaSession();
        resetSeek();

        if (autoplay) {
            audioEl.play().catch(() => setStatus('Tap play to listen'));
        }

        fetchPageText(page);
        saveProgress();
    }

    function changePage(dir) { loadPage(currentPage + dir); }

    function jumpToPage() {
        const errEl = $('jump-error');
        const val = parseInt($('jump-input').value);
        if (!book || isNaN(val) || val < 1 || val > book.pages) {
            errEl.textContent = `Enter a page from 1 to ${book ? book.pages : 1}.`;
            return;
        }
        errEl.textContent = '';
        if (Sheets.isOpen('more-sheet')) Sheets.close();
        loadPage(val - 1);
    }

    audioEl.addEventListener('canplay', () => {
        if (!book) return;
        setStatus('');
        readyPages.add(currentPage);
        updateTocReadiness();
    });
    audioEl.addEventListener('waiting', () => {
        if (!book) return;
        setStatus(readyPages.has(currentPage) ? 'Loading' : 'Generating audio', true);
    });
    audioEl.addEventListener('ended', () => {
        if (!book) return;
        saveProgress();
        if (sleepAtPageEnd) {
            // Sleep timer: stop here instead of moving on
            clearSleep();
            setStatus('Sleep timer: stopped');
            setPlaybackState('paused');
            return;
        }
        if (currentPage + 1 < book.pages) {
            // New src and play() inside the ended handler, so the
            // browser keeps the playback session (and lock screen) alive
            changePage(1);
        } else {
            setStatus('End of book');
            setPlaybackState('paused');
        }
    });

    $('btn-prev').addEventListener('click', () => changePage(-1));
    $('btn-next').addEventListener('click', () => changePage(1));
    $('jump-go').addEventListener('click', jumpToPage);
    $('jump-input').addEventListener('keydown', e => { if (e.key === 'Enter') jumpToPage(); });
    voiceEl.addEventListener('change', () => loadPage(currentPage));

    // ── PLAY / PAUSE AND SKIP 15 SECONDS ──
    function togglePlay() {
        if (!book) return;
        if (audioEl.paused) audioEl.play().catch(() => setStatus('Tap play to listen'));
        else audioEl.pause();
    }
    playBtn.addEventListener('click', togglePlay);
    miniPlay.addEventListener('click', togglePlay);

    function showPlaying(isPlaying) {
        for (const b of [playBtn, miniPlay]) {
            b.classList.toggle('is-playing', isPlaying);
            b.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
        }
    }
    audioEl.addEventListener('play',  () => showPlaying(true));
    audioEl.addEventListener('pause', () => showPlaying(false));

    $('back15-btn').addEventListener('click', () => seekBy(-15));
    $('fwd15-btn').addEventListener('click', () => seekBy(15));

    // ── SEEK BAR (and the mini player's progress line) ──
    let dragging = false;

    function fmt(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function paintSeek(position) {
        const duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
        const pct = duration > 0 ? (position / duration) * 100 : 0;
        seekEl.style.setProperty('--pct', pct + '%');
        $('mini-progress-fill').style.width = pct + '%';
        $('time-elapsed').textContent   = fmt(position);
        $('time-remaining').textContent = '-' + fmt(duration - position);
        seekEl.setAttribute('aria-valuetext', `${fmt(position)} of ${fmt(duration)}`);
    }

    function resetSeek() {
        seekEl.max = 0;
        seekEl.value = 0;
        paintSeek(0);
    }

    audioEl.addEventListener('loadedmetadata', () => {
        seekEl.max = isFinite(audioEl.duration) ? audioEl.duration : 0;
        paintSeek(audioEl.currentTime);
    });
    audioEl.addEventListener('timeupdate', () => {
        if (dragging) return;
        seekEl.value = audioEl.currentTime;
        paintSeek(audioEl.currentTime);
    });
    seekEl.addEventListener('input', () => {
        dragging = true;
        paintSeek(parseFloat(seekEl.value));
    });
    seekEl.addEventListener('change', () => {
        audioEl.currentTime = parseFloat(seekEl.value);
        dragging = false;
        updatePositionState();
    });
    seekEl.addEventListener('pointerup', () => { dragging = false; });

    // ── SLEEP TIMER ──
    let sleepTimer = null, sleepUntil = 0, sleepAtPageEnd = false, sleepTick = null;
    const sleepBtn = $('sleep-btn');

    function renderSleep(choice) {
        const label = $('sleep-label');
        if (sleepAtPageEnd)  label.textContent = 'Page';
        else if (sleepTimer) label.textContent = Math.max(1, Math.ceil((sleepUntil - Date.now()) / 60000)) + 'm';
        else                 label.textContent = '';
        sleepBtn.classList.toggle('is-active', !!(sleepTimer || sleepAtPageEnd));
        sleepBtn.setAttribute('aria-label', 'Sleep timer: ' + (sleepAtPageEnd ? 'end of page'
            : sleepTimer ? label.textContent.replace('m', ' minutes left') : 'off'));
        document.querySelectorAll('.sleep-opt').forEach(o => {
            const on = o.dataset.sleep === (choice || (sleepAtPageEnd ? 'page' : sleepTimer ? o.dataset.sleep : 'off'))
                       && (o.dataset.sleep !== 'off' || (!sleepTimer && !sleepAtPageEnd));
            o.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    function clearSleep() {
        clearTimeout(sleepTimer); clearInterval(sleepTick);
        sleepTimer = null; sleepTick = null; sleepAtPageEnd = false;
        renderSleep('off');
    }

    function setSleep(choice) {
        clearSleep();
        if (choice === 'page') {
            sleepAtPageEnd = true;
        } else if (choice !== 'off') {
            const minutes = parseInt(choice);
            sleepUntil = Date.now() + minutes * 60000;
            sleepTimer = setTimeout(() => {
                audioEl.pause();
                clearSleep();
                setStatus('Sleep timer: stopped');
            }, minutes * 60000);
            sleepTick = setInterval(() => renderSleep(String(minutes)), 30000);
        }
        renderSleep(choice);
    }

    sleepBtn.addEventListener('click', () => Sheets.open('sleep-sheet', sleepBtn));
    document.querySelectorAll('.sleep-opt').forEach(opt => {
        opt.addEventListener('click', () => { setSleep(opt.dataset.sleep); Sheets.close(); });
    });
    renderSleep('off');

    // ── SUB-SHEETS: More and Page text ──
    $('more-btn').addEventListener('click', e => Sheets.open('more-sheet', e.currentTarget));
    $('text-btn').addEventListener('click', e => Sheets.open('text-sheet', e.currentTarget));
    $('more-library').addEventListener('click', () => { Sheets.close({ restoreFocus: false }); collapseSheet(); });

    // ── PAGE TEXT ──
    async function fetchPageText(page) {
        const id = book.id;
        try {
            const res  = await fetch(`/page_text/${id}/${page}`);
            const data = await res.json();
            if (!book || book.id !== id || page !== currentPage) return;
            textBoxEl.textContent = data.text || "[No text on this page]";
        } catch {
            textBoxEl.textContent = "[Could not load page text]";
        }
        $('text-preview').textContent = textBoxEl.textContent;
    }

    // ── SAVE PROGRESS (works while the sheet is collapsed) ──
    function saveProgress() {
        if (!book) return Promise.resolve();
        return fetch('/save_progress', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
            body   : JSON.stringify({ book_id: book.id, page: currentPage, speed: speed, voice: voiceEl.value }),
        }).catch(() => {});
    }

    // ── CONTENTS ──
    async function loadToc(id) {
        let chapters = [];
        try { chapters = await (await fetch(`/toc/${id}`)).json(); } catch (e) { /* none */ }
        if (!book || book.id !== id) return;
        tocList.innerHTML = '';
        // PDFs without a contents list get "Page N" entries every 10 pages;
        // only real chapter titles are used as the chapter name
        tocChapters = chapters.every(ch => /^Page \d+$/.test(ch.title)) ? [] : chapters;

        if (!chapters.length) {
            tocList.innerHTML = '<p class="toc-loading">No contents found.</p>';
            return;
        }

        chapters.forEach(ch => {
            const item = document.createElement('button');
            item.type       = 'button';
            item.className  = 'toc-item' + (ch.level === 2 ? ' toc-sub' : '');
            item.dataset.page = ch.page;
            item.id         = 'toc-' + ch.page;

            const dot   = document.createElement('span');
            dot.className = 'toc-dot';
            dot.id        = 'dot-' + ch.page;

            const label = document.createElement('span');
            label.className = 'toc-label';
            label.textContent = ch.title;

            const pg    = document.createElement('span');
            pg.className  = 'toc-pg';
            pg.textContent = 'p.' + (ch.page + 1);

            item.append(dot, label, pg);
            item.onclick = () => { loadPage(ch.page); closeToc(); };
            tocList.appendChild(item);
        });

        updateTocReadiness();
        highlightTocItem(currentPage);
        updateSubtitle();
        updateMediaSession();
    }

    async function updateTocReadiness() {
        if (!book) return;
        const id = book.id;
        try {
            const data = await (await fetch(`/readiness/${id}?voice=${voiceEl.value}`)).json();
            if (!book || book.id !== id) return;
            readyPages = new Set(data.ready);
        } catch (e) { return; }
        document.querySelectorAll('.toc-dot').forEach(dot => {
            const page = parseInt(dot.id.replace('dot-', ''));
            dot.classList.toggle('dot-ready',      readyPages.has(page));
            dot.classList.toggle('dot-processing', !readyPages.has(page));
        });
    }

    function highlightTocItem(page) {
        let best = null;
        document.querySelectorAll('.toc-item').forEach(el => {
            el.classList.remove('toc-active');
            el.removeAttribute('aria-current');
            if (parseInt(el.dataset.page) <= page) best = el;   // closest chapter at or before the page
        });
        if (best) {
            best.classList.add('toc-active');
            best.setAttribute('aria-current', 'true');
            // On desktop the sidebar is visible; in drawer mode openToc scrolls it
            if (!drawerMode.matches && isExpanded()) best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    // ── CONTENTS DRAWER (small screens) ──
    const drawerMode = window.matchMedia('(max-width: 900px)');

    function syncTocMode() {
        tocSidebar.setAttribute('aria-hidden', drawerMode.matches && !Sheets.isOpen(tocSidebar) ? 'true' : 'false');
        tocSidebar.setAttribute('aria-modal', drawerMode.matches ? 'true' : 'false');
    }

    function openToc() {
        if (!drawerMode.matches) return;
        Sheets.open(tocSidebar, tocOpenBtn, {
            onOpen: () => {
                tocSidebar.classList.add('toc-open');
                const active = tocSidebar.querySelector('.toc-active');
                if (active) {
                    tocSidebar.scrollTop = active.offsetTop - tocSidebar.clientHeight / 2 + active.offsetHeight / 2;
                    active.focus({ preventScroll: true });
                }
            },
            onClose: () => { tocSidebar.classList.remove('toc-open'); syncTocMode(); },
        });
    }

    function closeToc() {
        if (Sheets.isOpen(tocSidebar)) Sheets.close();
    }

    tocOpenBtn.addEventListener('click', openToc);
    $('toc-close-btn').addEventListener('click', closeToc);
    drawerMode.addEventListener('change', () => { closeToc(); syncTocMode(); });
    syncTocMode();

    function updateSubtitle() {
        if (!book) return;
        const chapter = chapterTitle(currentPage);
        // The top bar always shows the page, so this is the chapter when there is one
        const text = chapter || `Page ${currentPage + 1} of ${book.pages}`;
        subEl.textContent = text;
        $('mini-sub').textContent = text;
    }

    function chapterTitle(page) {
        let title = null;
        for (const ch of tocChapters) {
            if (ch.page <= page) title = ch.title;
        }
        return title;
    }

    // ── EXPAND / COLLAPSE THE FULL PLAYER ──
    // Everything behind the open player is inert (no focus, no clicks)
    const BEHIND = ['app-header', 'app-content', 'mini-player', 'bottom-nav'];

    function isExpanded() { return sheetEl.classList.contains('is-open'); }

    function expandSheet() {
        if (!book) return;
        sheetEl.classList.add('is-open');
        sheetEl.setAttribute('aria-hidden', 'false');
        sheetEl.style.transform = '';
        document.body.classList.add('player-open');
        BEHIND.forEach(id => { const el = $(id); if (el) el.inert = true; });
        document.querySelector('.fab').inert = true;
        $('player-minimise').focus({ preventScroll: true });
        highlightTocItem(currentPage);
    }

    function collapseSheet() {
        if (!isExpanded()) return;
        if (Sheets.anyOpen()) Sheets.close({ restoreFocus: false });
        sheetEl.classList.remove('is-open');
        sheetEl.setAttribute('aria-hidden', 'true');
        sheetEl.style.transform = '';
        document.body.classList.remove('player-open');
        BEHIND.forEach(id => { const el = $(id); if (el) el.inert = false; });
        document.querySelector('.fab').inert = false;
        if (!miniEl.hidden) $('mini-open').focus({ preventScroll: true });
    }

    $('player-minimise').addEventListener('click', collapseSheet);
    $('mini-open').addEventListener('click', expandSheet);

    // Escape collapses (after any open sub-sheet has closed)
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || e.defaultPrevented || Sheets.anyOpen() || !isExpanded()) return;
        e.preventDefault();
        collapseSheet();
    });

    // Drag the top bar down to collapse
    $('player-drag').addEventListener('pointerdown', e => {
        if (e.target.closest('button, a') || !isExpanded()) return;
        const startY = e.clientY, startT = Date.now(), area = e.currentTarget;
        let dy = 0;
        sheetEl.classList.add('dragging');
        area.setPointerCapture(e.pointerId);
        const move = ev => { dy = Math.max(0, ev.clientY - startY); sheetEl.style.transform = `translateY(${dy}px)`; };
        const up = () => {
            area.removeEventListener('pointermove', move);
            area.removeEventListener('pointerup', up);
            area.removeEventListener('pointercancel', up);
            sheetEl.classList.remove('dragging');
            const fast = dy > 40 && dy / Math.max(1, Date.now() - startT) > 0.5;
            if (dy > 120 || fast) collapseSheet();
            else sheetEl.style.transform = '';
        };
        area.addEventListener('pointermove', move);
        area.addEventListener('pointerup', up);
        area.addEventListener('pointercancel', up);
    });

    // ── COLOUR FROM THE COVER ──
    // Sample the cover with a canvas and tint the player's background
    // (and the mini player). Falls back to a dark orange tint.
    function tintFromCover() {
        const img = $('cover-img');
        let colour = 'rgb(120, 46, 18)';
        try {
            const c = document.createElement('canvas');
            c.width = c.height = 24;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, 24, 24);
            const px = ctx.getImageData(0, 0, 24, 24).data;
            let r = 0, g = 0, b = 0, w = 0;
            for (let i = 0; i < px.length; i += 4) {
                const max = Math.max(px[i], px[i + 1], px[i + 2]), min = Math.min(px[i], px[i + 1], px[i + 2]);
                const weight = 1 + (max - min) / 32 + (max > 40 ? 1 : 0);   // prefer colourful, not black
                r += px[i] * weight; g += px[i + 1] * weight; b += px[i + 2] * weight; w += weight;
            }
            r /= w; g /= w; b /= w;
            // Keep it deep enough for white text on top
            const k = Math.min(1, 150 / Math.max(r, g, b, 1));
            if (Math.max(r, g, b) > 24) colour = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
        } catch (e) { /* keep the fallback */ }
        document.documentElement.style.setProperty('--glow', colour);
    }
    $('cover-img').addEventListener('load', tintFromCover);
    $('cover-img').addEventListener('error', tintFromCover);

    // ── LOCK SCREEN AND NOTIFICATION CONTROLS (Media Session API) ──
    // Set up once; the handlers act on whichever book is loaded.
    const mediaSession = ('mediaSession' in navigator) ? navigator.mediaSession : null;

    function updateMediaSession() {
        if (!mediaSession || typeof MediaMetadata === 'undefined' || !book) return;
        mediaSession.metadata = new MediaMetadata({
            title  : chapterTitle(currentPage) || `Page ${currentPage + 1} of ${book.pages}`,
            artist : book.author,
            album  : book.title,
            artwork: [96, 192, 512].map(size => ({
                src  : `/cover/${book.id}?size=${size}`,
                sizes: `${size}x${size}`,
                type : 'image/png',
            })),
        });
    }

    function setPlaybackState(state) {
        if (mediaSession) mediaSession.playbackState = state;
    }

    function updatePositionState() {
        if (!mediaSession || !mediaSession.setPositionState) return;
        const duration = audioEl.duration;
        if (!isFinite(duration) || duration <= 0) return;
        try {
            mediaSession.setPositionState({
                duration    : duration,
                playbackRate: audioEl.playbackRate,
                position    : Math.min(Math.max(audioEl.currentTime, 0), duration),
            });
        } catch (e) { /* ignore browsers that reject a value */ }
    }

    function seekBy(seconds) {
        if (!book) return;
        const end = isFinite(audioEl.duration) ? audioEl.duration : Infinity;
        audioEl.currentTime = Math.min(Math.max(audioEl.currentTime + seconds, 0), end);
        updatePositionState();
    }

    if (mediaSession) {
        const handlers = {
            play         : () => { if (book) audioEl.play(); },
            pause        : () => audioEl.pause(),
            previoustrack: () => changePage(-1),
            nexttrack    : () => changePage(1),
            seekbackward : details => seekBy(-((details && details.seekOffset) || 15)),
            seekforward  : details => seekBy((details && details.seekOffset) || 15),
            seekto       : details => {
                if (!book) return;
                if (details.fastSeek && 'fastSeek' in audioEl) audioEl.fastSeek(details.seekTime);
                else audioEl.currentTime = details.seekTime;
                updatePositionState();
            },
        };
        for (const [action, handler] of Object.entries(handlers)) {
            try { mediaSession.setActionHandler(action, handler); }
            catch (e) { /* action not supported by this browser */ }
        }
    }

    audioEl.addEventListener('play',  () => setPlaybackState('playing'));
    audioEl.addEventListener('pause', () => {
        // The pause that comes with a page ending is followed straight away
        // by the next page, so don't flash "paused" on the lock screen
        if (!audioEl.ended) setPlaybackState('paused');
    });
    for (const ev of ['timeupdate', 'loadedmetadata', 'ratechange', 'seeked']) {
        audioEl.addEventListener(ev, updatePositionState);
    }

    // ── PRELOAD THE NEXT PAGE ──
    // Halfway through a page, a hidden, muted audio object (never played,
    // not on the page) buffers the next page. The browser shares buffered
    // media between elements with the same URL, so when the player moves
    // on it starts from that buffer. Only pages whose audio already exists
    // are preloaded, so this never starts generation.
    const preloadEl = new Audio();
    preloadEl.preload = 'auto';
    preloadEl.muted   = true;
    let preloadedKey  = null;

    audioEl.addEventListener('timeupdate', () => {
        if (!book) return;
        const duration = audioEl.duration;
        if (!isFinite(duration) || duration <= 0 || audioEl.currentTime < duration / 2) return;
        const next = currentPage + 1;
        if (next >= book.pages || !readyPages.has(next)) return;
        const key = `${book.id}|${next}|${voiceEl.value}`;
        if (key === preloadedKey) return;
        preloadedKey = key;
        preloadEl.src = `/audio/${book.id}/${next}?voice=${voiceEl.value}`;
        preloadEl.load();
    });

    // Save on the way out (tab closed or reloaded)
    window.addEventListener('pagehide', () => {
        if (!book) return;
        const body = new Blob([JSON.stringify({ book_id: book.id, page: currentPage, speed: speed, voice: voiceEl.value })],
                              { type: 'application/json' });
        // sendBeacon can't set the CSRF header, so use a keepalive fetch
        fetch('/save_progress', { method: 'POST', keepalive: true, body,
                                  headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() } }).catch(() => {});
    });

    // For app.js and tests
    // Clear the player if this book is loaded or still opening (book deleted)
    function forget(id) {
        id = Number(id);
        if ((book && book.id === id) || pendingId === id) clear();
    }

    window.Player = {
        open, clear, forget,
        expand: expandSheet, collapse: collapseSheet, isExpanded,
        bookId: () => (book ? book.id : null),
    };
    window.changePage = changePage;
    window.jumpToPage = jumpToPage;
    window.openToc = openToc;
    window.closeToc = closeToc;
})();
