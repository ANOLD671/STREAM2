const CACHE_NAME = 'streammax-v3';
const DYNAMIC_CACHE = 'streammax-dynamic-v1';

// Critical assets to cache immediately
const urlsToCache = [
    '/',
    '/index.html',
    'https://cdn.jsdelivr.net/npm/hls.js@latest',
    'https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js',
    'https://cdn.jsdelivr.net/npm/dexie@3.2.3/dist/dexie.min.js'
];

// Install event - cache critical assets
self.addEventListener('install', event => {
    console.log('Service Worker installing...');
    self.skipWaiting(); // Force activation immediately
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Caching critical assets');
                return cache.addAll(urlsToCache);
            })
            .catch(error => {
                console.error('Cache install failed:', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
    console.log('Service Worker activating...');
    
    event.waitUntil(
        Promise.all([
            // Claim clients immediately
            self.clients.claim(),
            
            // Delete old caches
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cache => {
                        if (cache !== CACHE_NAME && cache !== DYNAMIC_CACHE) {
                            console.log('Deleting old cache:', cache);
                            return caches.delete(cache);
                        }
                    })
                );
            })
        ])
    );
});

// Optimized fetch with network-first strategy for streams
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Special handling for stream URLs (m3u8, ts, m3u)
    if (url.pathname.match(/\.(m3u8|ts|m3u|mp4|mkv|avi)$/i)) {
        // Network-first for streams - always get latest
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Cache successful stream responses
                    if (response.ok) {
                        const responseClone = response.clone();
                        caches.open(DYNAMIC_CACHE).then(cache => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Fallback to cache if offline
                    return caches.match(event.request);
                })
        );
        return;
    }
    
    // For API requests (M3U playlist)
    if (url.href.includes('iptv-org.github.io/iptv/index.m3u')) {
        // Stale-while-revalidate for playlist
        event.respondWith(
            caches.open(DYNAMIC_CACHE).then(cache => {
                return cache.match(event.request).then(cachedResponse => {
                    const fetchPromise = fetch(event.request)
                        .then(networkResponse => {
                            cache.put(event.request, networkResponse.clone());
                            return networkResponse;
                        })
                        .catch(error => {
                            console.log('Playlist fetch failed:', error);
                        });
                    
                    return cachedResponse || fetchPromise;
                });
            })
        );
        return;
    }
    
    // For static assets - cache-first
    event.respondWith(
        caches.match(event.request)
            .then(cachedResponse => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                
                return fetch(event.request).then(networkResponse => {
                    // Don't cache non-successful responses
                    if (!networkResponse || networkResponse.status !== 200) {
                        return networkResponse;
                    }
                    
                    // Cache successful responses
                    const responseClone = networkResponse.clone();
                    caches.open(DYNAMIC_CACHE).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                    
                    return networkResponse;
                });
            })
            .catch(error => {
                console.error('Fetch failed:', error);
                // Return offline fallback
                return caches.match('/offline.html');
            })
    );
});

// Background sync for offline actions
self.addEventListener('sync', event => {
    if (event.tag === 'sync-favorites') {
        event.waitUntil(syncFavorites());
    }
});

// Push notifications
self.addEventListener('push', event => {
    const options = {
        body: event.data.text(),
        icon: '/icon.png',
        badge: '/badge.png',
        vibrate: [200, 100, 200],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            { action: 'open', title: 'Open App' },
            { action: 'close', title: 'Close' }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification('StreamMax', options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
    event.notification.close();
    
    if (event.action === 'open') {
        event.waitUntil(
            clients.openWindow('/')
        );
    }
});

// Function to sync favorites (for offline support)
async function syncFavorites() {
    try {
        const cache = await caches.open(DYNAMIC_CACHE);
        const favorites = await getFavoritesFromDB();
        
        // Store favorites in cache for offline access
        await cache.put('/api/favorites', new Response(
            JSON.stringify(favorites),
            { headers: { 'Content-Type': 'application/json' } }
        ));
        
        console.log('Favorites synced successfully');
    } catch (error) {
        console.error('Sync failed:', error);
    }
}

// Helper function to get favorites (simplified)
async function getFavoritesFromDB() {
    // This would normally connect to IndexedDB
    // For now, return mock data
    return [];
}

// Periodic background sync (if supported)
self.addEventListener('periodicsync', event => {
    if (event.tag === 'update-channels') {
        event.waitUntil(updateChannelCache());
    }
});

// Update channel cache periodically
async function updateChannelCache() {
    try {
        const response = await fetch('https://iptv-org.github.io/iptv/index.m3u');
        if (response.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            await cache.put('/api/channels', response);
            console.log('Channel cache updated');
        }
    } catch (error) {
        console.error('Cache update failed:', error);
    }
}

// Handle errors and offline fallback
self.addEventListener('error', event => {
    console.error('Service Worker error:', event.error);
});

// Message handling from main thread
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    
    if (event.data.type === 'CACHE_CHANNELS') {
        const channels = event.data.channels;
        event.waitUntil(cacheChannels(channels));
    }
});

// Cache specific channels for offline viewing
async function cacheChannels(channels) {
    const cache = await caches.open(DYNAMIC_CACHE);
    
    // Only cache first 10 most popular channels
    const popularChannels = channels.slice(0, 10);
    
    for (const channel of popularChannels) {
        try {
            // Just cache the channel info, not the actual stream
            await cache.put(
                `/channel/${encodeURIComponent(channel.url)}`,
                new Response(JSON.stringify(channel), {
                    headers: { 'Content-Type': 'application/json' }
                })
            );
        } catch (error) {
            console.error('Failed to cache channel:', channel.name, error);
        }
    }
}

// Preload strategy for faster loading
self.addEventListener('fetch', event => {
    // Preload critical requests
    if (event.request.destination === 'document') {
        // Preload main page
        event.preloadResponse.then(response => {
            if (response) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseClone);
                });
                return response;
            }
        });
    }
});

// Log cache status for debugging
self.addEventListener('message', event => {
    if (event.data === 'GET_CACHE_STATUS') {
        caches.keys().then(keys => {
            event.source.postMessage({
                type: 'CACHE_STATUS',
                caches: keys
            });
        });
    }
});
