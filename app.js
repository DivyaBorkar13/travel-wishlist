/* ─── State ──────────────────────────────────────────────────── */
let map;
let places = [];
let markers = {};
let pendingPlace = null;
let editingId    = null;
let currentFilter = 'all';
let justAddedId   = null;
let searchDebounce;
const loadingIntentions = new Set();
const loadingPhotos     = new Set();

/* ─── Init ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadFromStorage();
    migrateExistingPlaces();
    renderSidebar();
    updateStats();
    bindEvents();
});

/* ─── One-time Migration ─────────────────────────────────────── */
function migrateExistingPlaces() {
    const BAD_PHOTO = /flag|coat|emblem|wikipedia|wiki/i;
    let changed = false;

    places.forEach(place => {
        if (place.photo && (BAD_PHOTO.test(place.photo) || place.photo.endsWith('.svg'))) {
            const seed = place.name.split(',')[0].trim().toLowerCase().replace(/\s+/g, '-');
            place.photo = `https://picsum.photos/seed/${encodeURIComponent(seed)}/800/400`;
            changed = true;
        }
        if (!place.intention || place.intention.startsWith('A place waiting to be discovered')) {
            place.intention = generateFallbackIntention(place.name);
            changed = true;
        }
    });

    if (changed) persist();
}

/* ─── Map ────────────────────────────────────────────────────── */
function initMap() {
    map = L.map('map', { center: [20, 10], zoom: 2, zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
}

/* ─── Storage ────────────────────────────────────────────────── */
function loadFromStorage() {
    try { places = JSON.parse(localStorage.getItem('travelWishlist') || '[]'); }
    catch { places = []; }
    places.forEach(p => addMarker(p, false));
}

function persist() {
    try { localStorage.setItem('travelWishlist', JSON.stringify(places)); }
    catch { showToast('⚠️ Storage full'); }
}

/* ─── API Key ────────────────────────────────────────────────── */
function getApiKey() { return localStorage.getItem('anthropicKey') || ''; }
function setApiKey(k) { localStorage.setItem('anthropicKey', k); }

/* ─── Markers ────────────────────────────────────────────────── */
function markerIcon(status) {
    const fill = status === 'visited' ? '#10b981' : '#f59e0b';
    const glow = status === 'visited' ? 'rgba(16,185,129,0.35)' : 'rgba(245,158,11,0.35)';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44"><defs><filter id="ds" x="-30%" y="-20%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="${glow}" flood-opacity="1"/></filter></defs><path filter="url(#ds)" d="M16 2C8.268 2 2 8.268 2 16c0 10.5 14 26 14 26S30 26.5 30 16C30 8.268 23.732 2 16 2z" fill="${fill}" stroke="white" stroke-width="2.5"/><circle cx="16" cy="16" r="5.5" fill="white" opacity="0.85"/></svg>`;
    return L.divIcon({ html: svg, className: '', iconSize: [32, 44], iconAnchor: [16, 44], popupAnchor: [0, -46] });
}

function addMarker(place, bounce = false) {
    const marker = L.marker([place.lat, place.lng], { icon: markerIcon(place.status) })
        .addTo(map)
        .bindPopup(buildPopup(place), { maxWidth: 290 });
    markers[place.id] = marker;

    if (bounce) {
        requestAnimationFrame(() => {
            const el = marker.getElement();
            if (!el) return;
            el.classList.add('marker-bounce');
            el.addEventListener('animationend', () => el.classList.remove('marker-bounce'), { once: true });
        });
    }
}

/* ─── Popup ──────────────────────────────────────────────────── */
function buildPopup(place) {
    const grad = place.photoGradient || getPlaceGradient(place.name);
    const photoHtml = place.photo
        ? `<div class="popup-photo-wrap" style="background:${grad}">
               <img class="popup-photo" src="${esc(place.photo)}" alt=""
                    style="opacity:0;transition:opacity 0.45s"
                    onload="this.style.opacity=1"
                    onerror="this.style.display='none'">
           </div>`
        : '';
    const intentionHtml = place.intention
        ? `<div class="popup-intention">${esc(place.intention)}</div>` : '';
    const noteHtml = place.note
        ? `<div class="popup-note">${esc(place.note)}</div>` : '';
    const label = place.status === 'wishlist' ? '⭐ Wishlist' : '✅ Visited';
    return `${photoHtml}
        <div class="popup-body">
            <div class="popup-status-bar ${place.status}"></div>
            <div class="popup-name">${esc(place.name)}</div>
            <div class="popup-address">${esc(shortAddress(place.address))}</div>
            ${intentionHtml}${noteHtml}
            <span class="popup-badge ${place.status}">${label}</span>
        </div>`;
}

/* ─── Auto-Photo: Picsum (deterministic, always scenic) ─────── */
function fetchPlacePhoto(place) {
    const seed = place.name.split(',')[0].trim().toLowerCase().replace(/\s+/g, '-');
    setPlacePhoto(place.id, `https://picsum.photos/seed/${encodeURIComponent(seed)}/800/400`);
}

function setPlacePhoto(id, photoUrl) {
    const place = places.find(p => p.id === id);
    loadingPhotos.delete(id);
    if (!place) return;
    place.photo = photoUrl;
    persist();
    renderSidebar();
    if (markers[id]) markers[id].setPopupContent(buildPopup(place));
}

/* 12 deterministic gradients keyed by place name hash */
function getPlaceGradient(name) {
    const palettes = [
        ['#667eea', '#764ba2'], ['#f093fb', '#f5576c'],
        ['#4facfe', '#00f2fe'], ['#43e97b', '#38f9d7'],
        ['#fa709a', '#fee140'], ['#a18cd1', '#fbc2eb'],
        ['#f7971e', '#ffd200'], ['#a1c4fd', '#c2e9fb'],
        ['#fd7043', '#ff8a65'], ['#26a69a', '#4dd0e1'],
        ['#e91e8c', '#f06292'], ['#7c4dff', '#e040fb'],
    ];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h << 5) - h + name.charCodeAt(i);
    const [c1, c2] = palettes[Math.abs(h) % palettes.length];
    return `linear-gradient(135deg,${c1},${c2})`;
}

/* ─── Fallback Intention Generator ──────────────────────────── */
function generateFallbackIntention(placeName) {
    const n = placeName.toLowerCase();
    if (/beach|island|bali|maldive|goa/.test(n))
        return 'Feel the warm sand between your toes and let the ocean wash your worries away';
    if (/mountain|alps|switzerland|himalaya|peak/.test(n))
        return 'Breathe in the crisp mountain air and let the peaks inspire your soul';
    if (/paris|france|rome|italy|europe/.test(n))
        return 'Wander through timeless streets where every corner tells a story';
    if (/japan|tokyo|kyoto/.test(n))
        return 'Find stillness in ancient temples and wonder in neon-lit streets';
    if (/india|rajasthan|kerala/.test(n))
        return 'Lose yourself in a land of colors, spices, and timeless traditions';
    if (/germany|berlin/.test(n))
        return 'Discover where history meets innovation in the heart of Europe';
    return 'A world of wonder awaits — pack your bags and answer the call';
}

/* ─── Intention Generation ───────────────────────────────────── */
async function generateIntention(place) {
    const key = getApiKey();
    if (!key) {
        finaliseIntention(place.id, generateFallbackIntention(place.name));
        return;
    }
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 100,
                messages: [{ role: 'user', content: `Write a single dreamy, evocative travel intention for ${place.name}. One sentence, 10-18 words, starting with an active verb. Poetic and sensory. No quotes. No period at end. Examples: "Sip coffee at a sidewalk café and get lost in Montmartre", "Chase golden sunsets and dance barefoot on the beach"` }]
            })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.log(`[intention] Anthropic API error ${res.status}:`, errText);
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        const text = data.content?.[0]?.text?.trim().replace(/^["'""'']|["'""'']$/g, '') || '';
        finaliseIntention(place.id, text || generateFallbackIntention(place.name));
    } catch (err) {
        console.log('[intention] generation failed:', err.message || err);
        finaliseIntention(place.id, generateFallbackIntention(place.name));
    }
}

function finaliseIntention(id, intention) {
    const place = places.find(p => p.id === id);
    if (!place) return;
    place.intention = intention;
    loadingIntentions.delete(id);
    persist();
    renderSidebar();
    if (markers[id]) markers[id].setPopupContent(buildPopup(place));
}

/* ─── Search ─────────────────────────────────────────────────── */
function bindSearchEvents() {
    const input = document.getElementById('searchInput');
    const btn   = document.getElementById('searchBtn');

    input.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const q = input.value.trim();
        if (q.length < 2) { hideResults(); return; }
        searchDebounce = setTimeout(() => doSearch(q), 380);
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { clearTimeout(searchDebounce); doSearch(input.value.trim()); }
        if (e.key === 'Escape') hideResults();
    });
    btn.addEventListener('click', () => doSearch(input.value.trim()));
    document.addEventListener('click', e => {
        if (!e.target.closest('.search-container')) hideResults();
    });
}

async function doSearch(q) {
    if (!q) return;
    const panel = document.getElementById('searchResults');
    panel.innerHTML = `<div class="search-status"><i class="fas fa-circle-notch fa-spin-custom"></i> Searching…</div>`;
    panel.classList.add('visible');
    try {
        const res  = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        if (!data.length) { panel.innerHTML = `<div class="search-status">No results found for "<strong>${esc(q)}</strong>"</div>`; return; }
        panel.innerHTML = data.map(item => {
            const name  = item.name || item.display_name.split(',')[0].trim();
            const parts = item.display_name.split(',').map(s => s.trim());
            const sub   = parts.length > 1 ? parts.slice(1, 3).join(', ') : '';
            return `<div class="search-result-item" data-lat="${item.lat}" data-lng="${item.lon}" data-name="${esc(name)}" data-address="${esc(item.display_name)}">
                        <div class="result-icon"><i class="fas fa-map-marker-alt"></i></div>
                        <div>
                            <div class="result-name">${esc(name)}</div>
                            ${sub ? `<div class="result-sub">${esc(sub)}</div>` : ''}
                        </div>
                    </div>`;
        }).join('');
        panel.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                const place = { lat: parseFloat(el.dataset.lat), lng: parseFloat(el.dataset.lng), name: el.dataset.name, address: el.dataset.address };
                document.getElementById('searchInput').value = place.name;
                hideResults();
                map.flyTo([place.lat, place.lng], 12, { duration: 1.3 });
                openAddModal(place);
            });
        });
    } catch { panel.innerHTML = `<div class="search-status">Search failed — check your connection</div>`; }
}

function hideResults() { document.getElementById('searchResults').classList.remove('visible'); }

/* ─── Add Modal ──────────────────────────────────────────────── */
function openAddModal(place) {
    pendingPlace = place;
    document.getElementById('modalPlaceInfo').innerHTML = `
        <div class="pi-name">${esc(place.name)}</div>
        <div class="pi-address">${esc(place.address)}</div>`;
    document.getElementById('noteInput').value = '';
    setModalStatus('wishlist');
    showOverlay('addModalOverlay');
    setTimeout(() => document.getElementById('noteInput').focus(), 150);
}

function setModalStatus(status) {
    document.querySelectorAll('#addModalOverlay .status-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.status === status)
    );
}

function saveNewPlace() {
    if (!pendingPlace) return;
    const note   = document.getElementById('noteInput').value.trim();
    const status = document.querySelector('#addModalOverlay .status-btn.active').dataset.status;

    const place = {
        id:            crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        name:          pendingPlace.name,
        address:       pendingPlace.address,
        lat:           pendingPlace.lat,
        lng:           pendingPlace.lng,
        note,
        status,
        photo:         null,
        photoGradient: getPlaceGradient(pendingPlace.name),
        intention:     null,
        addedAt:       new Date().toISOString()
    };

    places.unshift(place);
    persist();
    addMarker(place, true);
    loadingIntentions.add(place.id);
    loadingPhotos.add(place.id);
    justAddedId = place.id;
    renderSidebar();
    updateStats();
    closeOverlay('addModalOverlay');
    pendingPlace = null;

    showToast(`${status === 'wishlist' ? '⭐' : '✅'} "${place.name}" added!`);
    setTimeout(() => markers[place.id]?.openPopup(), 700);
    generateIntention(place);
    fetchPlacePhoto(place);
}

/* ─── Edit Modal ─────────────────────────────────────────────── */
function openEditModal(id) {
    const place = places.find(p => p.id === id);
    if (!place) return;
    editingId = id;
    document.getElementById('editModalPlaceInfo').innerHTML = `
        <div class="pi-name">${esc(place.name)}</div>
        <div class="pi-address">${esc(shortAddress(place.address))}</div>`;
    document.getElementById('editNoteInput').value = place.note || '';
    showOverlay('editModalOverlay');
    setTimeout(() => document.getElementById('editNoteInput').focus(), 150);
}

function saveEditedPlace() {
    const place = places.find(p => p.id === editingId);
    if (!place) return;
    place.note = document.getElementById('editNoteInput').value.trim();
    persist();
    if (markers[editingId]) markers[editingId].setPopupContent(buildPopup(place));
    renderSidebar();
    closeOverlay('editModalOverlay');
    editingId = null;
    showToast('✏️ Note saved!');
}

/* ─── Place Actions ──────────────────────────────────────────── */
function toggleStatus(id) {
    const place = places.find(p => p.id === id);
    if (!place) return;
    place.status = place.status === 'wishlist' ? 'visited' : 'wishlist';
    persist();
    if (markers[id]) { markers[id].setIcon(markerIcon(place.status)); markers[id].setPopupContent(buildPopup(place)); }
    renderSidebar();
    updateStats();
    showToast(place.status === 'visited' ? '✅ Marked as Visited!' : '⭐ Moved back to Wishlist!');
}

function deletePlace(id) {
    const place = places.find(p => p.id === id);
    if (!place) return;
    const doRemove = () => {
        if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
        places = places.filter(p => p.id !== id);
        loadingIntentions.delete(id);
        persist();
        renderSidebar();
        updateStats();
    };
    const card = document.querySelector(`.place-card[data-id="${id}"]`);
    if (card) { card.classList.add('card-removing'); setTimeout(doRemove, 290); }
    else doRemove();
    showToast(`🗑️ "${place.name}" removed`);
}

function flyTo(id) {
    const place = places.find(p => p.id === id);
    if (!place) return;
    map.flyTo([place.lat, place.lng], 12, { duration: 1.5 });
    setTimeout(() => markers[id]?.openPopup(), 1600);
}

/* ─── Sidebar Render ─────────────────────────────────────────── */
function renderSidebar() {
    const list     = document.getElementById('placesList');
    const filtered = currentFilter === 'all' ? places : places.filter(p => p.status === currentFilter);

    if (!filtered.length) {
        const icon = currentFilter === 'visited' ? 'check-circle' : currentFilter === 'wishlist' ? 'star' : 'map-marked-alt';
        const msg  = currentFilter === 'all' ? 'Search for a destination and pin it to start building your travel wishlist!' : `No ${currentFilter} places yet.`;
        list.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="fas fa-${icon}"></i></div><h3>Nothing here</h3><p>${msg}</p></div>`;
        return;
    }

    list.innerHTML = filtered.map(place => {
        const isLoading  = loadingIntentions.has(place.id);
        const toggleLabel = place.status === 'wishlist' ? 'Mark Visited' : 'To Wishlist';
        const toggleIcon  = place.status === 'wishlist' ? 'check-circle' : 'star';
        const badgeLabel  = place.status === 'wishlist' ? '⭐ Wishlist' : '✅ Visited';
        const grad = place.photoGradient || getPlaceGradient(place.name);

        // Show shimmer while the photo is being fetched; fade in the real image when ready.
        const photoHtml = loadingPhotos.has(place.id)
            ? `<div class="card-photo-strip"></div>`
            : place.photo
                ? `<div class="card-photo-strip" data-gradient="${grad}"><img src="${esc(place.photo)}" alt="" loading="lazy"></div>`
                : '';

        const intentionHtml = isLoading
            ? `<div class="shimmer-line"></div><div class="shimmer-line shimmer-short"></div>`
            : place.intention ? `<div class="intention-text">${esc(place.intention)}</div>` : '';

        const noteHtml = place.note ? `<div class="place-note">${esc(place.note)}</div>` : '';

        return `
            <div class="place-card ${place.status}${place.id === justAddedId ? ' card-new' : ''}" data-id="${place.id}">
                <div class="card-top">
                    <div class="card-names">
                        <div class="place-name">${esc(place.name)}</div>
                        <div class="place-country">${esc(shortAddress(place.address))}</div>
                    </div>
                    <span class="place-badge ${place.status}">${badgeLabel}</span>
                </div>
                ${photoHtml}${intentionHtml}${noteHtml}
                <div class="card-actions">
                    <button class="action-btn toggle-btn"><i class="fas fa-${toggleIcon}"></i> ${toggleLabel}</button>
                    <button class="action-btn edit-btn"><i class="fas fa-pencil-alt"></i></button>
                    <button class="action-btn delete-btn"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div>`;
    }).join('');

    justAddedId = null;

    // Bind photo load/error for shimmer → fade-in behaviour
    list.querySelectorAll('.card-photo-strip').forEach(strip => {
        const img  = strip.querySelector('img');
        const grad = strip.dataset.gradient;
        if (!img) return;

        const onLoad = () => {
            img.classList.add('loaded');
            strip.classList.add('photo-ready');
        };
        const onError = () => {
            strip.style.background = grad;
            strip.classList.add('photo-ready');
        };

        if (img.complete) {
            img.naturalWidth > 0 ? onLoad() : onError();
        } else {
            img.addEventListener('load',  onLoad,  { once: true });
            img.addEventListener('error', onError, { once: true });
        }
    });

    // Bind card actions
    list.querySelectorAll('.place-card').forEach(card => {
        const id = card.dataset.id;
        card.addEventListener('click', e => { if (!e.target.closest('.action-btn')) flyTo(id); });
        card.querySelector('.toggle-btn').addEventListener('click',  e => { e.stopPropagation(); toggleStatus(id); });
        card.querySelector('.edit-btn').addEventListener('click',    e => { e.stopPropagation(); openEditModal(id); });
        card.querySelector('.delete-btn').addEventListener('click',  e => { e.stopPropagation(); deletePlace(id); });
    });
}

function updateStats() {
    document.getElementById('wishlistCount').textContent = places.filter(p => p.status === 'wishlist').length;
    document.getElementById('visitedCount').textContent  = places.filter(p => p.status === 'visited').length;
}

/* ─── Event Wiring ───────────────────────────────────────────── */
function bindEvents() {
    bindSearchEvents();

    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.filter;
            renderSidebar();
        });
    });

    const sidebar   = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('toggleSidebar');
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        toggleBtn.classList.toggle('sidebar-hidden');
    });

    // Add modal
    document.getElementById('addModalClose').addEventListener('click',  () => closeOverlay('addModalOverlay'));
    document.getElementById('addModalCancel').addEventListener('click', () => closeOverlay('addModalOverlay'));
    document.getElementById('addModalSave').addEventListener('click',   saveNewPlace);
    document.getElementById('addModalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeOverlay('addModalOverlay'); });
    document.querySelectorAll('#addModalOverlay .status-btn').forEach(btn =>
        btn.addEventListener('click', () => setModalStatus(btn.dataset.status))
    );

    // Edit modal
    document.getElementById('editModalClose').addEventListener('click',  () => closeOverlay('editModalOverlay'));
    document.getElementById('editModalCancel').addEventListener('click', () => closeOverlay('editModalOverlay'));
    document.getElementById('editModalSave').addEventListener('click',   saveEditedPlace);
    document.getElementById('editModalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeOverlay('editModalOverlay'); });

    // Settings modal
    document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
    document.getElementById('settingsModalClose').addEventListener('click', () => closeOverlay('settingsModalOverlay'));
    document.getElementById('settingsCancel').addEventListener('click',     () => closeOverlay('settingsModalOverlay'));
    document.getElementById('settingsSave').addEventListener('click',        saveSettings);
    document.getElementById('settingsModalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeOverlay('settingsModalOverlay'); });
    document.getElementById('toggleKeyVis').addEventListener('click', () => {
        const inp = document.getElementById('apiKeyInput');
        inp.type  = inp.type === 'password' ? 'text' : 'password';
        document.querySelector('#toggleKeyVis i').className = inp.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeOverlay('addModalOverlay');
            closeOverlay('editModalOverlay');
            closeOverlay('settingsModalOverlay');
            hideResults();
        }
    });
}

/* ─── Settings ───────────────────────────────────────────────── */
function openSettingsModal() {
    document.getElementById('apiKeyInput').value = getApiKey();
    document.getElementById('apiKeyInput').type  = 'password';
    document.querySelector('#toggleKeyVis i').className = 'fas fa-eye';
    showOverlay('settingsModalOverlay');
}

function saveSettings() {
    const key = document.getElementById('apiKeyInput').value.trim();
    setApiKey(key);
    closeOverlay('settingsModalOverlay');
    showToast(key ? '🔑 API key saved!' : '🔑 API key cleared');
}

/* ─── Modal Helpers ──────────────────────────────────────────── */
function showOverlay(id) { document.getElementById(id).classList.add('visible'); }
function closeOverlay(id) {
    document.getElementById(id).classList.remove('visible');
    if (id === 'addModalOverlay')  pendingPlace = null;
    if (id === 'editModalOverlay') editingId    = null;
}

/* ─── Toast ──────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ─── Utilities ──────────────────────────────────────────────── */
function shortAddress(addr) {
    if (!addr) return '';
    const parts = addr.split(',').map(s => s.trim());
    return parts.length <= 2 ? addr : parts.slice(-3, -1).join(', ');
}

function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
