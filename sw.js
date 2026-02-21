const CACHE_NAME = 'streammax-v1';
const urlsToCache = [
    '/',
    'https://cdn.jsdelivr.net/npm/hls.js@latest',
    'https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js',
    'https://cdn.jsdelivr.net/npm/dexie@3.2.3/dist/dexie.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});
