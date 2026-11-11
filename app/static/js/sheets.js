// ─────────────────────────────────────────
// BOTTOM SHEETS
// One sheet open at a time. A sheet closes on a tap outside (the
// backdrop), on Escape, on Back, or when it is dragged down by its handle.
// Focus moves into the sheet, Tab stays inside it, and focus goes
// back to the button that opened it.
//
//   <div class="sheet" id="x" role="dialog" aria-modal="true">
//     <div class="sheet-handle-area"><div class="sheet-handle"></div></div> ...
//   </div>
//   Sheets.open('x', openerButton, { onOpen, onClose })
// ─────────────────────────────────────────
// ─────────────────────────────────────────
// BACK BUTTON FOR OPEN LAYERS
// Opening the full player or a sheet adds a history entry at the same
// address, so Back closes the top layer instead of leaving the page.
// Closing a layer any other way (button, swipe, Escape, tap outside)
// steps back over its entry, so Back never needs two presses.
//
//   Layers.opened('player', closeFn)   when a layer opens
//   Layers.closed('player')            when it closes by any other means
// ─────────────────────────────────────────
(function () {
    const stack = [];        // [{ name, close }], bottom to top; entry level = index + 1
    let toGo = 0;            // closes not yet sent to history (sent together)
    let inFlight = 0;        // our own back steps still to arrive as popstate
    let deferred = [];       // opens waiting for those back steps

    const level = state => (state && state.wLayer) || 0;

    // An entry left over from a reload: nothing is open now, so treat it as a page
    if (level(history.state)) history.replaceState({ htmx: true }, '');

    function flush() {
        if (!toGo) return;
        inFlight++;
        history.go(-toGo);
        toGo = 0;
    }

    function opened(name, close) {
        if (inFlight) { deferred.push(() => opened(name, close)); return; }
        if (stack.some(l => l.name === name)) return;
        stack.push({ name, close });
        if (toGo) {
            // A layer closed in this same moment: reuse its entry
            toGo--;
            history.replaceState({ wLayer: stack.length }, '');
        } else {
            history.pushState({ wLayer: stack.length }, '');
        }
    }

    function closed(name) {
        const i = stack.findIndex(l => l.name === name);
        if (i < 0) return;                  // already closed by Back
        toGo += stack.length - i;
        stack.length = i;
        queueMicrotask(flush);
    }

    // Capture phase, so this runs before htmx's handler and can stop it
    // (htmx would otherwise reload the page content on every Back)
    window.addEventListener('popstate', e => {
        const lvl = level(e.state);
        if (inFlight) {
            e.stopImmediatePropagation();
            inFlight--;
            if (!inFlight) { const run = deferred; deferred = []; run.forEach(f => f()); }
            return;
        }
        if (lvl < stack.length) {
            // Back: close the layers above this entry, top first
            e.stopImmediatePropagation();
            stack.splice(lvl).reverse().forEach(l => l.close());
        } else if (lvl > stack.length) {
            // Forward into an entry of a layer that is closed: step back off it
            e.stopImmediatePropagation();
            inFlight++;
            history.go(stack.length - lvl);
        }
    }, true);

    // A page load through htmx while a layer is open moves past its entries:
    // stop tracking them, so closing that layer later doesn't go back a page
    const forget = () => { stack.length = 0; toGo = 0; };
    document.addEventListener('htmx:pushedIntoHistory', forget);
    document.addEventListener('htmx:replacedInHistory', forget);

    window.Layers = { opened, closed, depth: () => stack.length };
})();

(function () {
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), ' +
                      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let current = null;     // { el, opener, options }

    function backdrop() {
        let el = document.getElementById('sheet-backdrop');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sheet-backdrop';
            el.className = 'sheet-backdrop';
            el.addEventListener('click', () => close());
            document.body.appendChild(el);
        }
        return el;
    }

    function visibleFocusables(el) {
        return [...el.querySelectorAll(FOCUSABLE)].filter(n => n.getClientRects().length > 0);
    }

    function open(id, opener, options = {}) {
        const el = typeof id === 'string' ? document.getElementById(id) : id;
        if (!el) return;
        if (current && current.el === el) return;
        // Swapping one sheet for another keeps the same history entry
        if (current) close({ restoreFocus: false, swap: true });
        else Layers.opened('sheet', () => close());
        current = { el, opener: opener || document.activeElement, options };

        el.classList.add('is-open');
        el.setAttribute('aria-hidden', 'false');
        // Put the backdrop right before the sheet, in the same stacking
        // context, so sheets inside the player sheet sit above it too
        const bd = backdrop();
        if (bd.nextElementSibling !== el) el.parentNode.insertBefore(bd, el);
        bd.classList.add('show');
        document.body.classList.add('sheet-open');
        if (current.opener && current.opener.setAttribute) current.opener.setAttribute('aria-expanded', 'true');
        if (options.onOpen) options.onOpen(el);

        const first = el.querySelector('[data-autofocus]') || visibleFocusables(el)[0];
        if (first) first.focus({ preventScroll: true });
    }

    function close({ restoreFocus = true, swap = false } = {}) {
        if (!current) return;
        const { el, opener, options } = current;
        current = null;
        if (!swap) Layers.closed('sheet');
        el.classList.remove('is-open');
        el.style.transform = '';
        el.setAttribute('aria-hidden', 'true');
        backdrop().classList.remove('show');
        document.body.classList.remove('sheet-open');
        if (opener && opener.setAttribute) opener.setAttribute('aria-expanded', 'false');
        if (options.onClose) options.onClose(el);
        if (restoreFocus && opener && opener.focus) opener.focus({ preventScroll: true });
    }

    function isOpen(id) {
        const el = typeof id === 'string' ? document.getElementById(id) : id;
        return !!current && current.el === el;
    }

    // Escape closes; Tab stays inside the open sheet
    document.addEventListener('keydown', e => {
        if (!current) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key !== 'Tab') return;
        const items = visibleFocusables(current.el);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!current.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });

    // Drag down by the handle area to close
    document.addEventListener('pointerdown', e => {
        const area = e.target.closest('.sheet-handle-area');
        if (!area || !current || !current.el.contains(area)) return;
        if (e.target.closest('button, a, input, select')) return;
        const el = current.el, startY = e.clientY, startT = Date.now();
        let dy = 0;
        el.classList.add('dragging');
        area.setPointerCapture(e.pointerId);
        const move = ev => {
            dy = Math.max(0, ev.clientY - startY);
            el.style.transform = `translateY(${dy}px)`;
        };
        const up = () => {
            area.removeEventListener('pointermove', move);
            area.removeEventListener('pointerup', up);
            area.removeEventListener('pointercancel', up);
            el.classList.remove('dragging');
            const fast = dy > 40 && dy / Math.max(1, Date.now() - startT) > 0.5;
            if (dy > 90 || fast) close();
            else el.style.transform = '';
        };
        area.addEventListener('pointermove', move);
        area.addEventListener('pointerup', up);
        area.addEventListener('pointercancel', up);
    });

    // Buttons with data-sheet-open="id" / data-sheet-close
    document.addEventListener('click', e => {
        const opener = e.target.closest('[data-sheet-open]');
        if (opener) { open(opener.dataset.sheetOpen, opener); return; }
        if (e.target.closest('[data-sheet-close]')) close();
    });

    window.Sheets = { open, close, isOpen, anyOpen: () => !!current, reduceMotion };
})();
