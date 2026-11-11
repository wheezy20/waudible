// On the login and register pages nobody is signed in: the service
// worker stops serving anyone's downloads until the next account's first
// page tells it who that is (offline.js). The downloads themselves stay,
// keyed by account, for whoever signs in again.
(function () {
    if (!('serviceWorker' in navigator)) return;
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'user', uid: null });
    try {
        const r = indexedDB.open('waudible', 1);
        r.onupgradeneeded = () => {
            const db = r.result;
            db.createObjectStore('books', { keyPath: ['uid', 'id'] });
            db.createObjectStore('progress', { keyPath: ['uid', 'id'] });
            db.createObjectStore('meta', { keyPath: 'key' });
        };
        r.onsuccess = () => {
            const t = r.result.transaction('meta', 'readwrite');
            t.objectStore('meta').delete('user');
            t.oncomplete = () => r.result.close();
        };
    } catch (e) { /* storage blocked */ }
})();
