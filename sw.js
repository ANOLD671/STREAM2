// ========== ULTIMATE IPTV ENGINE ==========
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.expand();
    tg.enableClosingConfirmation();
}

// ========== CONFIGURATION ==========
const CONFIG = {
    M3U_URL: 'https://iptv-org.github.io/iptv/index.m3u',
    MAX_CHANNELS: 50000, // Load ALL channels
    BATCH_SIZE: 500, // Process in batches
    PRELOAD_COUNT: 10, // Preload 10 channels
    RETRY_ATTEMPTS: 3,
    CACHE_VERSION: 'v2',
    BACKGROUND_AUDIO: true
};

// ========== DOM ELEMENTS ==========
const elements = {
    channelList: document.getElementById('channelList'),
    video: document.getElementById('video'),
    searchInput: document.getElementById('searchInput'),
    countryFilter: document.getElementById('countryFilter'),
    categoryFilter: document.getElementById('categoryFilter'),
    message: document.getElementById('message'),
    toast: document.getElementById('toast')
};

// ========== GLOBAL STATE ==========
const state = {
    allChannels: [],
    filteredChannels: [],
    currentTab: 'all',
    currentGroup: null,
    currentView: 'list',
    currentSort: 'name',
    favorites: new Set(),
    recentChannels: [],
    watchHistory: [],
    groups: {},
    settings: {},
    stats: {
        totalWatchTime: 0,
        channelsWatched: 0,
        streamsFailed: 0,
        streamsSuccess: 0
    },
    hls: null,
    backgroundHls: [],
    preloadQueue: [],
    isLoading: false,
    isOffline: !navigator.onLine,
    lastPlayed: null,
    wakeLock: null,
    sleepTimer: null
};

// ========== INITIALIZE DATABASE ==========
const DB = {
    async init() {
        return new Promise((resolve) => {
            const request = indexedDB.open('StreamMaxDB', 3);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create stores
                if (!db.objectStoreNames.contains('channels')) {
                    db.createObjectStore('channels', { keyPath: 'url' });
                }
                if (!db.objectStoreNames.contains('favorites')) {
                    db.createObjectStore('favorites', { keyPath: 'url' });
                }
                if (!db.objectStoreNames.contains('history')) {
                    const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
                    historyStore.createIndex('timestamp', 'timestamp');
                }
                if (!db.objectStoreNames.contains('groups')) {
                    db.createObjectStore('groups', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('stats')) {
                    db.createObjectStore('stats', { keyPath: 'key' });
                }
            };
            
            request.onsuccess = (event) => {
                state.db = event.target.result;
                console.log('✅ Database initialized');
                resolve();
            };
            
            request.onerror = () => {
                console.error('❌ Database failed');
                resolve(); // Continue even if DB fails
            };
        });
    },
    
    async saveChannels(channels) {
        if (!state.db) return;
        
        const tx = state.db.transaction('channels', 'readwrite');
        const store = tx.objectStore('channels');
        
        // Save in batches
        for (let i = 0; i < channels.length; i += 1000) {
            const batch = channels.slice(i, i + 1000);
            batch.forEach(ch => store.put(ch));
        }
        
        return tx.complete;
    },
    
    async getCachedChannels() {
        if (!state.db) return [];
        
        return new Promise((resolve) => {
            const tx = state.db.transaction('channels', 'readonly');
            const store = tx.objectStore('channels');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve([]);
        });
    }
};

// ========== LOAD ALL CHANNELS ==========
async function loadAllChannels() {
    if (state.isLoading) return;
    state.isLoading = true;
    
    showMessage('📡 Loading ALL channels...', 'info');
    showToast('This may take a moment...');
    
    try {
        // Try cache first
        const cached = await DB.getCachedChannels();
        if (cached.length > 0) {
            state.allChannels = cached;
            renderChannels();
            populateFilters();
            showMessage(`✅ Loaded ${cached.length} channels from cache`, 'success');
        }
        
        // Fetch fresh in background
        fetchAllChannelsWithProgress();
        
    } catch (error) {
        console.error('Load error:', error);
        handleLoadError();
    }
}

// ========== FETCH WITH PROGRESS ==========
async function fetchAllChannelsWithProgress() {
    try {
        showMessage('📡 Downloading master playlist...', 'info');
        
        const response = await fetch(CONFIG.M3U_URL);
        const text = await response.text();
        
        // Parse in chunks
        const chunks = splitM3UIntoChunks(text);
        let allParsed = [];
        
        showMessage(`📦 Processing ${chunks.length} chunks...`, 'info');
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const parsed = parseM3UChunk(chunk);
            allParsed = allParsed.concat(parsed);
            
            // Update progress
            const percent = Math.round((i / chunks.length) * 100);
            showMessage(`📊 Processing: ${percent}% (${allParsed.length} channels)`, 'info');
            
            // Yield to UI
            await new Promise(r => setTimeout(r, 10));
        }
        
        // Deduplicate
        const unique = deduplicateChannels(allParsed);
        
        state.allChannels = unique;
        await DB.saveChannels(unique);
        
        showMessage(`✅ Loaded ${unique.length} channels!`, 'success');
        showToast(`🎉 ${unique.length} channels ready`);
        
        renderChannels();
        populateFilters();
        preloadPopularChannels();
        
    } catch (error) {
        console.error('Fetch error:', error);
        handleLoadError();
    }
}

// ========== SPLIT M3U INTO CHUNKS ==========
function splitM3UIntoChunks(text) {
    const lines = text.split('\n');
    const chunks = [];
    const CHUNK_SIZE = 10000; // 10,000 lines per chunk
    
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        chunks.push(lines.slice(i, i + CHUNK_SIZE).join('\n'));
    }
    
    return chunks;
}

// ========== PARSE M3U CHUNK ==========
function parseM3UChunk(content) {
    const lines = content.split('\n');
    const channels = [];
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF')) {
            const name = lines[i].split(',').pop()?.trim() || 'Unknown';
            const url = lines[i + 1]?.trim();
            
            if (url && url.startsWith('http')) {
                // Extract all metadata
                const tvgId = lines[i].match(/tvg-id="(.*?)"/)?.[1] || '';
                const tvgName = lines[i].match(/tvg-name="(.*?)"/)?.[1] || '';
                const tvgLogo = lines[i].match(/tvg-logo="(.*?)"/)?.[1] || '';
                const groupTitle = lines[i].match(/group-title="(.*?)"/)?.[1] || 'Uncategorized';
                const tvgCountry = lines[i].match(/tvg-country="(.*?)"/)?.[1] || 'Unknown';
                const tvgLanguage = lines[i].match(/tvg-language="(.*?)"/)?.[1] || 'Unknown';
                
                channels.push({
                    name: tvgName || name,
                    displayName: name,
                    url,
                    logo: tvgLogo,
                    category: groupTitle,
                    country: tvgCountry,
                    language: tvgLanguage,
                    tvgId,
                    quality: detectQuality(name, url),
                    isWorking: true,
                    lastChecked: Date.now(),
                    popularity: 0,
                    added: Date.now()
                });
            }
        }
    }
    
    return channels;
}

// ========== DEDUPLICATE CHANNELS ==========
function deduplicateChannels(channels) {
    const seen = new Map();
    
    channels.forEach(ch => {
        const key = ch.url;
        if (!seen.has(key)) {
            seen.set(key, ch);
        }
    });
    
    return Array.from(seen.values());
}

// ========== DETECT QUALITY ==========
function detectQuality(name, url) {
    const qualities = [
        { name: '4K', regex: /4k|2160p|uhd/i, score: 4 },
        { name: '1080p', regex: /1080|fullhd|fhd/i, score: 3 },
        { name: '720p', regex: /720|hd/i, score: 2 },
        { name: '480p', regex: /480|sd/i, score: 1 }
    ];
    
    for (const q of qualities) {
        if (q.regex.test(name) || q.regex.test(url)) {
            return q.name;
        }
    }
    
    return 'Auto';
}

// ========== HANDLE LOAD ERROR ==========
function handleLoadError() {
    if (state.allChannels.length === 0) {
        showMessage('❌ Using demo channels', 'error');
        // Create demo channels
        state.allChannels = generateDemoChannels(1000);
        renderChannels();
    }
    state.isLoading = false;
}

// ========== GENERATE DEMO CHANNELS ==========
function generateDemoChannels(count) {
    const countries = ['USA', 'UK', 'Canada', 'Germany', 'France', 'Japan', 'Australia'];
    const categories = ['News', 'Sports', 'Entertainment', 'Movies', 'Music', 'Documentary'];
    const channels = [];
    
    for (let i = 0; i < count; i++) {
        channels.push({
            name: `Channel ${i + 1}`,
            url: `https://demo.com/stream${i}`,
            country: countries[Math.floor(Math.random() * countries.length)],
            category: categories[Math.floor(Math.random() * categories.length)],
            language: 'English',
            quality: 'Auto'
        });
    }
    
    return channels;
}

// ========== BACKGROUND PRELOADING ==========
function preloadPopularChannels() {
    // Get most popular categories
    const categories = {};
    state.allChannels.forEach(ch => {
        categories[ch.category] = (categories[ch.category] || 0) + 1;
    });
    
    // Preload top channels from each category
    const popularCategories = Object.entries(categories)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat]) => cat);
    
    popularCategories.forEach(category => {
        const channels = state.allChannels
            .filter(ch => ch.category === category)
            .slice(0, 2);
        
        channels.forEach(ch => preloadChannelInBackground(ch));
    });
}

// ========== PRELOAD CHANNEL IN BACKGROUND ==========
function preloadChannelInBackground(channel) {
    if (!CONFIG.BACKGROUND_AUDIO) return;
    if (state.preloadQueue.includes(channel.url)) return;
    
    state.preloadQueue.push(channel.url);
    
    // Create hidden audio element
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = channel.url;
    audio.volume = 0; // Silent
    
    // Store reference
    state.backgroundHls.push({
        url: channel.url,
        element: audio,
        timestamp: Date.now()
    });
    
    // Clean up old preloads
    setTimeout(() => {
        const index = state.backgroundHls.findIndex(p => p.url === channel.url);
        if (index > -1) {
            state.backgroundHls[index].element.src = '';
            state.backgroundHls.splice(index, 1);
        }
        state.preloadQueue = state.preloadQueue.filter(u => u !== channel.url);
    }, 300000); // Keep for 5 minutes
}

// ========== PLAY STREAM WITH BACKGROUND ==========
function playStream(channel) {
    if (!channel) return;
    
    showMessage('⚡ Starting stream...', 'info');
    
    // Check if already preloaded
    const preloaded = state.backgroundHls.find(p => p.url === channel.url);
    if (preloaded) {
        console.log('🎯 Using preloaded stream');
        // Transfer preloaded to main player
        const audio = preloaded.element;
        elements.video.src = audio.src;
        elements.video.currentTime = audio.currentTime;
        elements.video.play();
        
        // Clean up
        audio.src = '';
        state.backgroundHls = state.backgroundHls.filter(p => p.url !== channel.url);
        state.preloadQueue = state.preloadQueue.filter(u => u !== channel.url);
        
        showMessage('', '');
        return;
    }
    
    // Normal play
    playStreamWithRetry(channel);
}

// ========== PLAY WITH RETRY ==========
async function playStreamWithRetry(channel, attempt = 1) {
    // Save to history
    addToHistory(channel);
    
    // Track stats
    state.stats.channelsWatched++;
    
    // Kill previous stream
    if (state.hls) {
        state.hls.destroy();
        state.hls = null;
    }
    
    elements.video.pause();
    elements.video.removeAttribute('src');
    elements.video.load();
    
    // Preconnect to domain
    preconnectToDomain(channel.url);
    
    // Play
    if (Hls.isSupported()) {
        state.hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 60,
            fragLoadingTimeOut: 20000,
            manifestLoadingTimeOut: 10000,
            levelLoadingTimeOut: 10000
        });
        
        state.hls.loadSource(channel.url);
        state.hls.attachMedia(elements.video);
        
        state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            showMessage('', '');
            elements.video.play().catch(() => {
                showMessage('▶️ Tap to play', 'info');
            });
            
            // Track success
            state.stats.streamsSuccess++;
            saveStats();
            
            // Preload next channels
            preloadNextChannels(channel);
        });
        
        state.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                state.stats.streamsFailed++;
                
                if (attempt < CONFIG.RETRY_ATTEMPTS) {
                    showMessage(`🔄 Retry ${attempt}/${CONFIG.RETRY_ATTEMPTS}...`, 'info');
                    setTimeout(() => {
                        playStreamWithRetry(channel, attempt + 1);
                    }, 2000 * attempt);
                } else {
                    showMessage('❌ Stream failed', 'error');
                    tryAlternativeStream(channel);
                }
            }
        });
        
    } else {
        elements.video.src = channel.url;
        elements.video.play().catch(() => {
            showMessage('▶️ Tap to play', 'info');
        });
    }
    
    // Start wake lock
    requestWakeLock();
    
    // Update last played
    state.lastPlayed = channel;
    localStorage.setItem('lastPlayed', JSON.stringify({
        url: channel.url,
        name: channel.name,
        timestamp: Date.now()
    }));
}

// ========== PRELOAD NEXT CHANNELS ==========
function preloadNextChannels(currentChannel) {
    const index = state.filteredChannels.findIndex(ch => ch.url === currentChannel.url);
    if (index === -1) return;
    
    // Preload next 5
    for (let i = 1; i <= 5; i++) {
        if (index + i < state.filteredChannels.length) {
            const next = state.filteredChannels[index + i];
            preloadChannelInBackground(next);
        }
    }
    
    // Preload previous 2 (for back button)
    for (let i = 1; i <= 2; i++) {
        if (index - i >= 0) {
            const prev = state.filteredChannels[index - i];
            preloadChannelInBackground(prev);
        }
    }
}

// ========== PRECONNECT TO DOMAIN ==========
function preconnectToDomain(url) {
    try {
        const domain = new URL(url).origin;
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = domain;
        document.head.appendChild(link);
        
        setTimeout(() => {
            if (link.parentNode) link.parentNode.removeChild(link);
        }, 10000);
    } catch (e) {}
}

// ========== TRY ALTERNATIVE STREAM ==========
function tryAlternativeStream(channel) {
    // Try different quality
    const alternatives = state.allChannels.filter(ch => 
        ch.name === channel.name && ch.url !== channel.url
    );
    
    if (alternatives.length > 0) {
        showMessage('🔄 Trying alternative stream...', 'info');
        playStream(alternatives[0]);
    }
}

// ========== ADD TO HISTORY ==========
function addToHistory(channel) {
    const historyItem = {
        id: Date.now(),
        url: channel.url,
        name: channel.name,
        category: channel.category,
        timestamp: Date.now(),
        watchTime: 0
    };
    
    state.watchHistory.unshift(historyItem);
    state.watchHistory = state.watchHistory.slice(0, 100); // Keep last 100
    
    localStorage.setItem('watchHistory', JSON.stringify(state.watchHistory));
    
    // Update recent
    state.recentChannels = state.recentChannels.filter(c => c.url !== channel.url);
    state.recentChannels.unshift(channel);
    state.recentChannels = state.recentChannels.slice(0, 20);
    localStorage.setItem('recentChannels', JSON.stringify(state.recentChannels));
}

// ========== REQUEST WAKE LOCK ==========
async function requestWakeLock() {
    if ('wakeLock' in navigator && !state.wakeLock) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
            
            state.wakeLock.addEventListener('release', () => {
                console.log('Wake lock released');
            });
        } catch (err) {
            console.log('Wake lock error:', err);
        }
    }
}

// ========== RELEASE WAKE LOCK ==========
function releaseWakeLock() {
    if (state.wakeLock) {
        state.wakeLock.release();
        state.wakeLock = null;
    }
}

// ========== RENDER CHANNELS ==========
function renderChannels() {
    if (!elements.channelList) return;
    
    // Get filtered channels
    state.filteredChannels = getFilteredChannels();
    
    if (state.filteredChannels.length === 0) {
        elements.channelList.innerHTML = `
            <div class="empty-state">
                <div class="icon">📺</div>
                <div>No channels found</div>
            </div>
        `;
        return;
    }
    
    // Render as list
    let html = '';
    const start = 0;
    const end = Math.min(100, state.filteredChannels.length);
    
    for (let i = start; i < end; i++) {
        const ch = state.filteredChannels[i];
        const isFav = state.favorites.has(ch.url);
        
        html += `
            <div class="channel" data-url="${ch.url}" data-index="${i}">
                <div class="channel-info">
                    <div class="channel-name">
                        ${ch.name}
                        ${ch.quality !== 'Auto' ? `<span class="quality-badge">${ch.quality}</span>` : ''}
                    </div>
                    <div class="channel-meta">
                        <span>${ch.country}</span>
                        <span>•</span>
                        <span>${ch.category}</span>
                        <span>•</span>
                        <span>${ch.language}</span>
                    </div>
                </div>
                <div class="channel-actions">
                    <button class="action-btn fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${ch.url}')">
                        ${isFav ? '⭐' : '☆'}
                    </button>
                    <button class="action-btn play-btn" onclick="event.stopPropagation(); playStream(${JSON.stringify(ch).replace(/"/g, '&quot;')})">
                        ▶️
                    </button>
                </div>
            </div>
        `;
    }
    
    elements.channelList.innerHTML = html;
    
    // Add click handlers
    document.querySelectorAll('.channel').forEach(el => {
        el.addEventListener('click', () => {
            const index = parseInt(el.dataset.index);
            const channel = state.filteredChannels[index];
            if (channel) playStream(channel);
        });
    });
    
    // Show count
    if (state.filteredChannels.length > 100) {
        showToast(`${state.filteredChannels.length} channels available`);
    }
}

// ========== GET FILTERED CHANNELS ==========
function getFilteredChannels() {
    let filtered = [...state.allChannels];
    
    // Tab filter
    if (state.currentTab === 'favorites') {
        filtered = filtered.filter(c => state.favorites.has(c.url));
    } else if (state.currentTab === 'recent') {
        return state.recentChannels;
    } else if (state.currentTab === 'history') {
        return state.watchHistory.map(h => 
            state.allChannels.find(c => c.url === h.url)
        ).filter(Boolean);
    }
    
    // Country filter
    const country = elements.countryFilter?.value;
    if (country && country !== 'all') {
        filtered = filtered.filter(c => c.country === country);
    }
    
    // Category filter
    const category = elements.categoryFilter?.value;
    if (category && category !== 'all') {
        filtered = filtered.filter(c => c.category === category);
    }
    
    // Language filter (if exists)
    const language = document.getElementById('languageFilter')?.value;
    if (language && language !== 'all') {
        filtered = filtered.filter(c => c.language === language);
    }
    
    // Search filter
    const search = elements.searchInput?.value.toLowerCase();
    if (search) {
        filtered = filtered.filter(c => 
            c.name.toLowerCase().includes(search) ||
            c.country.toLowerCase().includes(search) ||
            c.category.toLowerCase().includes(search) ||
            c.language.toLowerCase().includes(search)
        );
    }
    
    // Sort
    if (state.currentSort === 'name') {
        filtered.sort((a, b) => a.name.localeCompare(b.name));
    } else if (state.currentSort === 'country') {
        filtered.sort((a, b) => a.country.localeCompare(b.country));
    } else if (state.currentSort === 'popularity') {
        filtered.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    }
    
    return filtered;
}

// ========== POPULATE FILTERS ==========
function populateFilters() {
    if (!elements.countryFilter || !elements.categoryFilter) return;
    
    // Countries
    const countries = [...new Set(state.allChannels.map(c => c.country))].sort();
    elements.countryFilter.innerHTML = '<option value="all">🌍 All Countries</option>';
    countries.slice(0, 100).forEach(country => {
        if (country && country !== 'Unknown') {
            const option = document.createElement('option');
            option.value = country;
            option.textContent = country;
            elements.countryFilter.appendChild(option);
        }
    });
    
    // Categories
    const categories = [...new Set(state.allChannels.map(c => c.category))].sort();
    elements.categoryFilter.innerHTML = '<option value="all">📺 All Categories</option>';
    categories.slice(0, 50).forEach(category => {
        if (category && category !== 'Uncategorized') {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            elements.categoryFilter.appendChild(option);
        }
    });
    
    // Languages (if filter exists)
    const langFilter = document.getElementById('languageFilter');
    if (langFilter) {
        const languages = [...new Set(state.allChannels.map(c => c.language))].sort();
        langFilter.innerHTML = '<option value="all">🗣️ All Languages</option>';
        languages.slice(0, 30).forEach(lang => {
            if (lang && lang !== 'Unknown') {
                const option = document.createElement('option');
                option.value = lang;
                option.textContent = lang;
                langFilter.appendChild(option);
            }
        });
    }
}

// ========== FAVORITES SYSTEM ==========
function toggleFavorite(url) {
    if (state.favorites.has(url)) {
        state.favorites.delete(url);
        showToast('❌ Removed from favorites');
    } else {
        state.favorites.add(url);
        showToast('⭐ Added to favorites');
        
        // Haptic feedback
        if (tg?.HapticFeedback) {
            tg.HapticFeedback.impactOccurred('medium');
        }
    }
    
    localStorage.setItem('favorites', JSON.stringify([...state.favorites]));
    
    if (state.currentTab === 'favorites') {
        renderChannels();
    } else {
        // Update just the button
        const btn = document.querySelector(`.fav-btn[data-url="${url}"]`);
        if (btn) {
            btn.textContent = state.favorites.has(url) ? '⭐' : '☆';
            btn.classList.toggle('active', state.favorites.has(url));
        }
    }
}

// ========== FULLSCREEN ==========
function enterFullscreen() {
    const video = elements.video;
    
    if (video.requestFullscreen) {
        video.requestFullscreen();
    } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
    } else if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
    } else if (video.mozRequestFullScreen) {
        video.mozRequestFullScreen();
    } else if (video.msRequestFullscreen) {
        video.msRequestFullscreen();
    }
}

// ========== SLEEP TIMER ==========
function setSleepTimer(minutes = 30) {
    if (state.sleepTimer) clearTimeout(state.sleepTimer);
    
    state.sleepTimer = setTimeout(() => {
        elements.video.pause();
        releaseWakeLock();
        showToast('⏰ Sleep timer activated');
        
        if (tg?.MainButton) {
            tg.MainButton.hide();
        }
    }, minutes * 60000);
    
    showToast(`⏰ Sleep timer: ${minutes} minutes`);
}

// ========== SHOW MESSAGE ==========
function showMessage(text, type = 'info') {
    if (!elements.message) return;
    
    elements.message.textContent = text;
    elements.message.style.display = text ? 'block' : 'none';
    
    if (type === 'error') {
        elements.message.style.background = '#ff4444';
    } else if (type === 'success') {
        elements.message.style.background = '#00c851';
    } else {
        elements.message.style.background = '#1a1a1a';
    }
}

// ========== SHOW TOAST ==========
function showToast(text, duration = 2000) {
    if (!elements.toast) return;
    
    elements.toast.textContent = text;
    elements.toast.classList.add('show');
    
    setTimeout(() => {
        elements.toast.classList.remove('show');
    }, duration);
}

// ========== SAVE STATS ==========
function saveStats() {
    localStorage.setItem('stats', JSON.stringify(state.stats));
}

// ========== LOAD STATS ==========
function loadStats() {
    const saved = localStorage.getItem('stats');
    if (saved) {
        try {
            state.stats = JSON.parse(saved);
        } catch (e) {}
    }
}

// ========== LOAD FAVORITES ==========
function loadFavorites() {
    const saved = localStorage.getItem('favorites');
    if (saved) {
        try {
            state.favorites = new Set(JSON.parse(saved));
        } catch (e) {}
    }
}

// ========== LOAD RECENT ==========
function loadRecent() {
    const saved = localStorage.getItem('recentChannels');
    if (saved) {
        try {
            state.recentChannels = JSON.parse(saved);
        } catch (e) {}
    }
}

// ========== LOAD HISTORY ==========
function loadHistory() {
    const saved = localStorage.getItem('watchHistory');
    if (saved) {
        try {
            state.watchHistory = JSON.parse(saved);
        } catch (e) {}
    }
}

// ========== LOAD LAST PLAYED ==========
function loadLastPlayed() {
    const saved = localStorage.getItem('lastPlayed');
    if (saved) {
        try {
            state.lastPlayed = JSON.parse(saved);
        } catch (e) {}
    }
}

// ========== SETUP EVENT LISTENERS ==========
function setupEventListeners() {
    // Search with debounce
    let searchTimeout;
    elements.searchInput?.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(renderChannels, 300);
    });
    
    // Filters
    elements.countryFilter?.addEventListener('change', renderChannels);
    elements.categoryFilter?.addEventListener('change', renderChannels);
    
    const langFilter = document.getElementById('languageFilter');
    if (langFilter) langFilter.addEventListener('change', renderChannels);
    
    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.currentTab = tab.dataset.type;
            renderChannels();
            
            // Back button
            if (state.currentTab !== 'all' && tg?.BackButton) {
                tg.BackButton.show();
            } else if (tg?.BackButton) {
                tg.BackButton.hide();
            }
        });
    });
    
    // Video controls
    document.getElementById('playPauseBtn')?.addEventListener('click', () => {
        if (elements.video.paused) {
            elements.video.play();
            document.getElementById('playPauseBtn').textContent = '⏸️';
        } else {
            elements.video.pause();
            document.getElementById('playPauseBtn').textContent = '▶️';
        }
    });
    
    document.getElementById('fullscreenBtn')?.addEventListener('click', enterFullscreen);
    document.getElementById('fullscreenBtn2')?.addEventListener('click', enterFullscreen);
    
    document.getElementById('sleepTimerBtn')?.addEventListener('click', () => {
        setSleepTimer(30);
    });
    
    // Progress bar
    elements.video.addEventListener('timeupdate', () => {
        const progress = (elements.video.currentTime / elements.video.duration) * 100 || 0;
        document.getElementById('progressFill').style.width = progress + '%';
    });
    
    document.getElementById('progressBar')?.addEventListener('click', (e) => {
        const rect = e.target.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        elements.video.currentTime = pos * elements.video.duration;
    });
    
    // Handle pause
    elements.video.addEventListener('pause', () => {
        document.getElementById('playPauseBtn').textContent = '▶️';
        releaseWakeLock();
    });
    
    elements.video.addEventListener('play', () => {
        document.getElementById('playPauseBtn').textContent = '⏸️';
        requestWakeLock();
    });
    
    // Network status
    window.addEventListener('online', () => {
        state.isOffline = false;
        showToast('📶 Back online');
    });
    
    window.addEventListener('offline', () => {
        state.isOffline = true;
        showToast('📴 Offline mode');
    });
    
    // Back button
    if (tg?.BackButton) {
        tg.BackButton.onClick(() => {
            state.currentTab = 'all';
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelector('[data-type="all"]')?.classList.add('active');
            renderChannels();
            tg.BackButton.hide();
        });
    }
    
    // Orientation change
    screen.orientation?.addEventListener('change', () => {
        if (screen.orientation.type.includes('landscape') && !elements.video.paused) {
            enterFullscreen();
        }
    });
}

// ========== INITIALIZE ==========
async function init() {
    console.log('🚀 Initializing StreamMax...');
    
    // Load data
    loadFavorites();
    loadRecent();
    loadHistory();
    loadStats();
    loadLastPlayed();
    
    // Setup UI
    setupEventListeners();
    
    // Initialize database
    await DB.init();
    
    // Load channels
    await loadAllChannels();
    
    // Auto-play last channel
    if (state.lastPlayed && !state.isOffline) {
        setTimeout(() => {
            const channel = state.allChannels.find(c => c.url === state.lastPlayed.url);
            if (channel) {
                playStream(channel);
            }
        }, 2000);
    }
    
    // Start background processes
    startBackgroundProcesses();
    
    console.log('✅ StreamMax ready!');
}

// ========== START BACKGROUND PROCESSES ==========
function startBackgroundProcesses() {
    // Check for updates every hour
    setInterval(() => {
        if (!state.isOffline) {
            console.log('🔄 Checking for updates...');
            // Light refresh
        }
    }, 3600000);
    
    // Clean up preloads every 5 minutes
    setInterval(() => {
        const now = Date.now();
        state.backgroundHls = state.backgroundHls.filter(p => {
            if (now - p.timestamp > 300000) { // 5 minutes
                p.element.src = '';
                return false;
            }
            return true;
        });
    }, 60000);
    
    // Save stats periodically
    setInterval(saveStats, 60000);
}

// ========== START ==========
document.addEventListener('DOMContentLoaded', init);
