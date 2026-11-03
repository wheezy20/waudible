// ─────────────────────────────────────────
// BOTTOM SHEETS
// One sheet open at a time. A sheet closes on a tap outside (the
// backdrop), on Escape, or when it is dragged down by its handle.
// Focus moves into the sheet, Tab stays inside it, and focus goes
// back to the button that opened it.
//
//   <div class="sheet" id="x" role="dialog" aria-modal="true">
//     <div class="sheet-handle-area"><div class="sheet-handle"></div></div> ...
//   </div>
//   Sheets.open('x', openerButton, { onOpen, onClose })
// ─────────────────────────────────────────
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
        if (current && current.el !== el) close({ restoreFocus: false });
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

    function close({ restoreFocus = true } = {}) {
        if (!current) return;
        const { el, opener, options } = current;
        current = null;
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
