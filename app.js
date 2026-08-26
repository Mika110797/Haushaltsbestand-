(() => {
  const main = document.getElementById('main');
  // Prevent accidental browser zoom gestures so the installed PWA feels like a native app.
  // Normal one-finger scrolling stays enabled.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(type => {
    document.addEventListener(type, event => event.preventDefault(), { passive: false });
  });
  document.addEventListener('touchmove', event => {
    if (event.touches && event.touches.length > 1) event.preventDefault();
  }, { passive: false });

  const bottomNav = document.getElementById('bottomNav');
  const logoutBtn = document.getElementById('logoutBtn');
  const toastEl = document.getElementById('toast');
  const categoryDialog = document.getElementById('categoryDialog');
  const itemDialog = document.getElementById('itemDialog');
  const categoryForm = document.getElementById('categoryForm');
  const itemForm = document.getElementById('itemForm');
  const cancelCategoryBtn = document.getElementById('cancelCategoryBtn');
  const cancelItemBtn = document.getElementById('cancelItemBtn');
  const scanDialog = document.getElementById('scanDialog');
  const scanCameraInput = document.getElementById('scanCameraInput');
  const scanPreview = document.getElementById('scanPreview');
  const scanProgressPanel = document.getElementById('scanProgressPanel');
  const scanStatus = document.getElementById('scanStatus');
  const scanProgressBar = document.getElementById('scanProgressBar');
  const scanResults = document.getElementById('scanResults');
  const scanCandidates = document.getElementById('scanCandidates');
  const scanRawText = document.getElementById('scanRawText');

  const config = window.APP_CONFIG || {};
  const configured = config.supabaseUrl && config.supabasePublishableKey &&
    !config.supabaseUrl.startsWith('HIER_') && !config.supabasePublishableKey.startsWith('HIER_');

  let db = null;
  let session = null;
  let household = null;
  let locations = [];
  let categories = [];
  let items = [];
  let deletedItems = [];
  let movements = [];
  let activeTab = 'stock';
  let activeLocation = 'all';
  let activeCategory = 'all';
  let searchTerm = '';
  let authMode = 'login';
  let realtimeChannel = null;
  let scanText = '';
  let scanSelectedItemId = null;
  let scanMatches = [];
  let scanObjectUrl = '';

  const esc = (value='') => String(value)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#039;');

  const normalizeScanText = (value='') => String(value)
    .toLocaleLowerCase('de')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('ß', 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const scanTokens = (value='') => normalizeScanText(value).split(' ').filter(token => token.length >= 3);

  function scoreScanMatch(item, recognizedText) {
    const haystack = normalizeScanText(recognizedText);
    const words = new Set(scanTokens(recognizedText));
    const name = normalizeScanText(item.name);
    let score = 0;

    if (name && haystack.includes(name)) score += 14;
    scanTokens(item.name).forEach(token => {
      if (words.has(token)) score += 5;
      else if (haystack.includes(token)) score += 2;
    });

    const aliases = Array.isArray(item.recognition_terms) ? item.recognition_terms : [];
    aliases.forEach(alias => {
      const normalizedAlias = normalizeScanText(alias);
      if (!normalizedAlias) return;
      if (haystack.includes(normalizedAlias)) score += 8;
      else scanTokens(alias).forEach(token => { if (words.has(token)) score += 1; });
    });

    return score;
  }

  function scanConfidence(score) {
    if (score >= 14) return 'sehr passend';
    if (score >= 8) return 'passend';
    return 'möglich';
  }

  function toast(message, actionLabel='', actionFn=null) {
    toastEl.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button id="toastAction" type="button">${esc(actionLabel)}</button>` : ''}`;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    if (actionLabel && actionFn) {
      const btn = document.getElementById('toastAction');
      if (btn) btn.onclick = async () => {
        toastEl.classList.remove('show');
        await actionFn();
      };
    }
    toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), actionLabel ? 5000 : 2400);
  }

  function setBusy(button, busy, label='Speichern') {
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? 'Bitte warten …' : label;
  }

  function renderSetup() {
    bottomNav.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    main.innerHTML = `
      <section class="card hero">
        <h2>Fast fertig</h2>
        <p>Die App ist gebaut. Für die gemeinsame Synchronisierung fehlen nur noch die zwei Werte aus deinem kostenlosen Supabase-Projekt.</p>
      </section>
      <section class="card">
        <strong>Danach kommt hier automatisch der Login.</strong>
        <p style="color:#737373">Trage Projekt-URL und den <em>Publishable Key</em> in <code>config.js</code> ein. Niemals den Service-Role-Key verwenden.</p>
      </section>`;
  }

  function renderAuth(message='') {
    bottomNav.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    main.innerHTML = `
      <section class="card hero">
        <h2>Gemeinsamer Bestand 💗</h2>
        <p>Melde dich an oder erstelle ein Konto. Danach könnt ihr denselben Haushalt auf iPhone und Android verwenden.</p>
      </section>
      <section class="card">
        <div class="auth-switch">
          <button id="loginMode" class="${authMode==='login'?'active':''}" type="button">Anmelden</button>
          <button id="signupMode" class="${authMode==='signup'?'active':''}" type="button">Konto erstellen</button>
        </div>
        ${message ? `<p class="badge">${esc(message)}</p>` : ''}
        <form id="authForm">
          <label>E-Mail<input id="authEmail" type="email" autocomplete="email" required /></label>
          <label>Passwort<input id="authPassword" type="password" minlength="6" autocomplete="current-password" required /></label>
          <button id="authSubmit" class="primary-btn" style="width:100%" type="submit">${authMode==='login'?'Anmelden':'Konto erstellen'}</button>
        </form>
      </section>`;

    document.getElementById('loginMode').onclick = () => { authMode='login'; renderAuth(); };
    document.getElementById('signupMode').onclick = () => { authMode='signup'; renderAuth(); };
    document.getElementById('authForm').onsubmit = handleAuth;
  }

  async function handleAuth(event) {
    event.preventDefault();
    const btn = document.getElementById('authSubmit');
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    setBusy(btn, true, authMode==='login'?'Anmelden':'Konto erstellen');
    try {
      if (authMode === 'signup') {
        const { data, error } = await db.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          authMode = 'login';
          renderAuth('Bitte bestätige einmal die E-Mail und melde dich danach an.');
          return;
        }
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      toast(err.message || 'Anmeldung fehlgeschlagen.');
      setBusy(btn, false, authMode==='login'?'Anmelden':'Konto erstellen');
    }
  }

  async function loadHousehold() {
    const { data, error } = await db
      .from('household_members')
      .select('household_id, households(id,name,invite_code)')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) throw error;
    household = data?.households || null;
  }

  function renderNoHousehold() {
    bottomNav.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    main.innerHTML = `
      <section class="card hero"><h2>Haushalt verbinden</h2><p>Eine Person erstellt den Haushalt. Die zweite tritt danach mit dem Einladungscode bei.</p></section>
      <section class="card">
        <h2>Neuen Haushalt erstellen</h2>
        <form id="createHouseholdForm">
          <label>Name<input id="householdName" maxlength="60" value="Unser Haushalt" required /></label>
          <button class="primary-btn" type="submit">Haushalt erstellen</button>
        </form>
      </section>
      <section class="card">
        <h2>Bestehendem Haushalt beitreten</h2>
        <form id="joinHouseholdForm">
          <label>Einladungscode<input id="inviteCode" maxlength="10" autocapitalize="characters" placeholder="AB12CD34EF" required /></label>
          <button class="secondary-btn" type="submit">Beitreten</button>
        </form>
      </section>`;
    document.getElementById('createHouseholdForm').onsubmit = createHousehold;
    document.getElementById('joinHouseholdForm').onsubmit = joinHousehold;
  }

  async function createHousehold(e) {
    e.preventDefault();
    const name = document.getElementById('householdName').value.trim();
    const { error } = await db.rpc('create_household', { p_name: name });
    if (error) return toast(error.message);
    await bootstrapApp();
    toast('Haushalt erstellt.');
  }

  async function joinHousehold(e) {
    e.preventDefault();
    const code = document.getElementById('inviteCode').value.trim().toUpperCase();
    const { error } = await db.rpc('join_household', { p_invite_code: code });
    if (error) return toast(error.message);
    await bootstrapApp();
    toast('Haushalt verbunden.');
  }

  function locationLabel(location) {
    if (!location) return 'Unbekannt';
    if (location.name === 'Vanessas Haushalt') return 'Vanessa';
    if (location.name === 'Mikas Haushalt') return 'Mika';
    return location.name.replace(/\s+Haushalt$/i, '');
  }

  function locationById(id) {
    return locations.find(location => location.id === id) || null;
  }

  function categoryById(id) {
    return categories.find(category => category.id === id) || null;
  }

  function itemLocationId(item) {
    return categoryById(item?.category_id)?.location_id || null;
  }

  function itemBelongsToActiveLocation(item) {
    return activeLocation === 'all' || itemLocationId(item) === activeLocation;
  }

  function categoriesForLocation(locationId = activeLocation) {
    if (locationId === 'all') return categories;
    return categories.filter(category => category.location_id === locationId);
  }

  function itemsForActiveLocation(source = items) {
    return source.filter(item => itemBelongsToActiveLocation(item));
  }

  function locationSwitcher() {
    const buttons = [
      ...locations.map(location => ({
        id: location.id,
        label: `🏠 ${locationLabel(location)}`
      })),
      { id:'all', label:'🏘️ Alle' }
    ];
    return `
      <section class="card" style="padding:10px 12px;margin-bottom:12px">
        <div class="item-meta" style="font-weight:800;margin-bottom:7px;color:#8f285a">Wohnung</div>
        <div class="category-chip-row" style="margin:0">
          ${buttons.map(button => `<button class="category-chip location-chip ${activeLocation===button.id?'active':''}" data-location="${button.id}" type="button">${esc(button.label)}</button>`).join('')}
        </div>
      </section>`;
  }

  function bindLocationSwitcher() {
    document.querySelectorAll('[data-location]').forEach(button => {
      button.onclick = () => {
        activeLocation = button.dataset.location;
        activeCategory = 'all';
        if (household?.id) localStorage.setItem(`haushaltsbestand-location-${household.id}`, activeLocation);
        renderApp();
      };
    });
  }

  function resolveActiveLocation() {
    const saved = household?.id ? localStorage.getItem(`haushaltsbestand-location-${household.id}`) : null;
    if (saved === 'all' || locations.some(location => location.id === saved)) {
      activeLocation = saved;
      return;
    }
    const vanessa = locations.find(location => location.name === 'Vanessas Haushalt');
    activeLocation = vanessa?.id || locations[0]?.id || 'all';
  }

  async function ensureInventoryLocations() {
    const desired = [
      { name:'Vanessas Haushalt', icon:'🏠', sort_order:10 },
      { name:'Mikas Haushalt', icon:'🏠', sort_order:20 }
    ];
    const normalized = new Set(locations.map(location => location.name.toLocaleLowerCase('de')));
    const missing = desired.filter(entry => !normalized.has(entry.name.toLocaleLowerCase('de')));
    if (!missing.length) return false;

    const { error } = await db.from('inventory_locations').insert(
      missing.map(entry => ({ household_id: household.id, ...entry }))
    );
    if (error) throw error;
    return true;
  }

  async function ensureStandardCategories() {
    const standards = [
      { name:'Kühlschrank', icon:'🧊' },
      { name:'Vorratskammer', icon:'🥫' },
      { name:'Keller', icon:'📦' }
    ];
    const missing = [];
    locations.forEach(location => {
      standards.forEach(standard => {
        const exists = categories.some(category =>
          category.location_id === location.id &&
          category.name.toLocaleLowerCase('de') === standard.name.toLocaleLowerCase('de')
        );
        if (!exists) {
          missing.push({
            household_id: household.id,
            location_id: location.id,
            ...standard
          });
        }
      });
    });

    if (missing.length) {
      const { error } = await db.from('categories').insert(missing);
      if (error) console.warn('Standardkategorien:', error);
      return true;
    }
    return false;
  }

  async function loadData() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [locationRes, catRes, itemRes, movementRes] = await Promise.all([
      db.from('inventory_locations').select('*').eq('household_id', household.id).order('sort_order').order('created_at'),
      db.from('categories').select('*').eq('household_id', household.id).order('created_at'),
      db.from('items').select('*').eq('household_id', household.id).order('name'),
      db.from('stock_movements').select('id,item_id,delta,kind,undo_of,is_correction,created_at').eq('household_id', household.id).gte('created_at', since).order('created_at', { ascending:false })
    ]);
    if (locationRes.error) throw locationRes.error;
    if (catRes.error) throw catRes.error;
    if (itemRes.error) throw itemRes.error;
    if (movementRes.error) throw movementRes.error;
    locations = locationRes.data || [];
    categories = catRes.data || [];
    const allItemRows = itemRes.data || [];
    items = allItemRows.filter(item => !item.deleted_at);
    deletedItems = allItemRows.filter(item => item.deleted_at).sort((a,b) => new Date(b.deleted_at) - new Date(a.deleted_at));
    movements = movementRes.data || [];
  }

  function renderApp() {
    bottomNav.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
    if (activeTab === 'stock') renderStock();
    if (activeTab === 'shopping') renderShopping();
    if (activeTab === 'stats') renderStatistics();
    if (activeTab === 'settings') renderSettings();
  }

  function categoryName(id) {
    const c = categoryById(id);
    return c ? `${c.icon || '📦'} ${c.name}` : 'Ohne Kategorie';
  }

  function itemPlaceLabel(item) {
    const category = categoryById(item?.category_id);
    if (!category) return 'Ohne Kategorie';
    const location = locationById(category.location_id);
    const locationPart = location ? `🏠 ${locationLabel(location)} · ` : '';
    return `${locationPart}${category.icon || '📦'} ${category.name}`;
  }

  function consumption30(itemId) {
    const undone = new Set(movements.filter(m => m.undo_of).map(m => Number(m.undo_of)));
    return movements
      .filter(m => m.item_id === itemId && m.kind === 'change' && m.delta < 0 && !m.is_correction && !undone.has(Number(m.id)))
      .reduce((sum, m) => sum + Math.abs(m.delta), 0);
  }

  function filteredItems() {
    let result = itemsForActiveLocation(items);
    if (activeCategory === 'favorites') result = result.filter(i => i.is_favorite);
    else if (activeCategory !== 'all') result = result.filter(i => i.category_id === activeCategory);
    const q = searchTerm.trim().toLocaleLowerCase('de');
    if (q) result = result.filter(i => i.name.toLocaleLowerCase('de').includes(q));
    if (activeCategory === 'all') {
      result.sort((a,b) => {
        const categoryA = categoryById(a.category_id)?.name || 'Ohne Kategorie';
        const categoryB = categoryById(b.category_id)?.name || 'Ohne Kategorie';
        const categoryCompare = categoryA.localeCompare(categoryB, 'de', { sensitivity:'base' });
        return categoryCompare || a.name.localeCompare(b.name, 'de', { sensitivity:'base' });
      });
    } else {
      result.sort((a,b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name,'de'));
    }
    return result;
  }

  function renderStock() {
    const filtered = filteredItems();
    const scopedItems = itemsForActiveLocation(items);
    const lowItems = scopedItems.filter(i => i.quantity <= i.min_quantity);
    const visibleCategories = activeLocation === 'all' ? [] : categoriesForLocation(activeLocation);
    const needsHomeSelection = activeLocation === 'all';
    const selectedCategory = activeCategory !== 'all' && activeCategory !== 'favorites' ? categoryById(activeCategory) : null;

    main.innerHTML = `
      ${locationSwitcher()}
      <div class="section-title">
        <h2>Bestand</h2>
        <div class="actions">
          <button id="scanPackageBtn" class="scan-btn" type="button">📷 Scannen <span>Beta</span></button>
          <button id="addCategoryBtn" class="small-btn" type="button">+ Kategorie</button>
          <button id="addItemBtn" class="primary-btn" type="button">+ Artikel</button>
        </div>
      </div>
      ${needsHomeSelection ? `<div class="card" style="padding:11px 13px;margin-bottom:12px"><span class="item-meta">Zum Anlegen eines Artikels oder einer Kategorie bitte zuerst <strong>Vanessa</strong> oder <strong>Mika</strong> auswählen.</span></div>` : ''}
      ${lowItems.length ? `<div class="alert-card">🔔 ${lowItems.length === 1 ? '1 Artikel ist knapp.' : `${lowItems.length} Artikel sind knapp.`}</div>` : ''}
      <div class="search-wrap"><input id="stockSearch" type="search" placeholder="Artikel suchen …" value="${esc(searchTerm)}" /></div>
      <div class="category-chip-row">
        <button class="category-chip ${activeCategory==='all'?'active':''}" data-cat="all">Alle</button>
        <button class="category-chip ${activeCategory==='favorites'?'active':''}" data-cat="favorites">⭐ Favoriten</button>
        ${visibleCategories.map(c => `<button class="category-chip ${activeCategory===c.id?'active':''}" data-cat="${c.id}">${esc(c.icon || '📦')} ${esc(c.name)}</button>`).join('')}
      </div>
      ${selectedCategory?.description ? `<div class="card" style="padding:10px 13px;margin-bottom:12px"><span class="item-meta">${esc(selectedCategory.description)}</span></div>` : ''}
      <div class="item-list">
        ${filtered.length ? filtered.map(itemCard).join('') : `<div class="card empty">Keine passenden Artikel gefunden.</div>`}
      </div>`;

    bindLocationSwitcher();
    document.getElementById('scanPackageBtn').onclick = openPackageScanner;
    document.getElementById('addCategoryBtn').onclick = openCategoryDialog;
    document.getElementById('addItemBtn').onclick = () => openItemDialog();
    document.getElementById('stockSearch').oninput = (e) => { searchTerm = e.target.value; renderStock(); document.getElementById('stockSearch')?.focus(); };
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { activeCategory = b.dataset.cat; renderStock(); });
    bindItemButtons();
  }

  function itemCard(item) {
    const isLow = item.quantity <= item.min_quantity;
    const pack = Math.max(1, Number(item.package_size || 1));
    return `<article class="item-card ${item.is_favorite ? 'favorite' : ''}" data-item="${item.id}">
      <div>
        <div class="item-head">
          <button class="favorite-btn ${item.is_favorite ? 'active' : ''}" data-favorite="${item.id}" type="button" aria-label="Favorit umschalten">${item.is_favorite ? '★' : '☆'}</button>
          <div>
            <div class="item-name">${esc(item.name)}</div>
            <div class="item-meta">${esc(activeLocation === 'all' ? itemPlaceLabel(item) : categoryName(item.category_id))} · Mindestbestand ${item.min_quantity} ${esc(item.unit || '')} ${isLow ? '<span class="low">· 🔔 knapp</span>' : ''}</div>
            ${pack > 1 ? `<div class="item-meta">📦 1 Packung = ${pack} ${esc(item.unit || '')}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="qty-control">
        <button class="qty-btn minus" data-id="${item.id}" type="button" aria-label="Bestand verringern">−</button>
        <div class="qty">${item.quantity}<div class="item-meta">${esc(item.unit || '')}</div></div>
        <button class="qty-btn plus" data-id="${item.id}" type="button" aria-label="Bestand erhöhen">+</button>
      </div>
      <div class="item-tools">
        ${pack > 1 ? `<button class="small-btn package-btn" data-pack="${item.id}" type="button">📦 +1 Packung</button>` : ''}
        <button class="small-btn edit" data-id="${item.id}" type="button">Bearbeiten</button>
        <button class="small-btn delete" data-id="${item.id}" type="button">Löschen</button>
      </div>
    </article>`;
  }

  function bindItemButtons() {
    document.querySelectorAll('.minus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, -1));
    document.querySelectorAll('.plus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, 1));
    document.querySelectorAll('[data-pack]').forEach(b => b.onclick = () => {
      const item = items.find(i => i.id === b.dataset.pack);
      if (item) changeQuantity(item.id, Math.max(1, Number(item.package_size || 1)));
    });
    document.querySelectorAll('[data-favorite]').forEach(b => b.onclick = () => toggleFavorite(b.dataset.favorite));
    document.querySelectorAll('.edit').forEach(b => b.onclick = () => openItemDialog(items.find(i => i.id === b.dataset.id)));
    document.querySelectorAll('.delete').forEach(b => b.onclick = () => deleteItem(b.dataset.id));
  }

  async function changeQuantity(id, delta) {
    const item = items.find(x => x.id === id);
    if (!item) return;
    const previous = item.quantity;
    item.quantity = Math.max(0, item.quantity + delta);
    renderApp();
    const { data, error } = await db.rpc('change_item_quantity_v3', { p_item_id: id, p_delta: delta });
    if (error) {
      item.quantity = previous;
      renderApp();
      return toast(error.message);
    }
    if (data && typeof data.quantity === 'number') item.quantity = data.quantity;
    if (data?.movement_id) {
      const amount = Math.abs(Number(data.delta || delta));
      const text = Number(data.delta || delta) > 0 ? `+${amount} gebucht.` : `−${amount} gebucht.`;
      toast(text, 'Rückgängig', () => undoMovement(data.movement_id));
    }
    await loadData();
    renderApp();
  }

  async function undoMovement(movementId) {
    const { error } = await db.rpc('undo_quantity_change_v3', { p_movement_id: movementId });
    if (error) return toast(error.message);
    await loadData();
    renderApp();
    toast('Änderung rückgängig gemacht.');
  }

  async function toggleFavorite(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    const next = !item.is_favorite;
    item.is_favorite = next;
    renderApp();
    const { error } = await db.from('items').update({ is_favorite: next }).eq('id', id);
    if (error) {
      item.is_favorite = !next;
      renderApp();
      return toast(error.message);
    }
    toast(next ? 'Zu Favoriten hinzugefügt. ⭐' : 'Aus Favoriten entfernt.');
  }

  async function deleteItem(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    if (!confirm(`„${item.name}“ in den Papierkorb verschieben?`)) return;

    const deletedAt = new Date().toISOString();
    const { error } = await db.from('items').update({ deleted_at: deletedAt }).eq('id', id);
    if (error) return toast(error.message);

    item.deleted_at = deletedAt;
    items = items.filter(i => i.id !== id);
    deletedItems = [item, ...deletedItems];
    renderApp();
    toast('Artikel in den Papierkorb verschoben.', 'Rückgängig', () => restoreDeletedItem(id));
  }

  async function restoreDeletedItem(id) {
    const item = deletedItems.find(i => i.id === id);
    const { error } = await db.from('items').update({ deleted_at: null }).eq('id', id);
    if (error) return toast(error.message);

    if (item) {
      item.deleted_at = null;
      deletedItems = deletedItems.filter(i => i.id !== id);
      items = [...items, item].sort((a,b) => a.name.localeCompare(b.name, 'de'));
    } else {
      await loadData();
    }
    renderApp();
    toast('Artikel wiederhergestellt.');
  }

  function openPackageScanner() {
    const scanItems = itemsForActiveLocation(items);
    if (!scanItems.length) return toast('In dieser Auswahl gibt es noch keine Artikel.');
    if (!window.Tesseract) return toast('Texterkennung konnte nicht geladen werden. Bitte Internetverbindung prüfen.');
    scanCameraInput.value = '';
    scanCameraInput.click();
  }

  function resetScanUi(file) {
    scanText = '';
    scanSelectedItemId = null;
    scanMatches = [];
    if (scanObjectUrl) URL.revokeObjectURL(scanObjectUrl);
    scanObjectUrl = URL.createObjectURL(file);
    scanPreview.src = scanObjectUrl;
    scanProgressPanel.classList.remove('hidden');
    scanResults.classList.add('hidden');
    scanProgressBar.style.width = '4%';
    scanStatus.textContent = 'Bild wird vorbereitet …';
    scanCandidates.innerHTML = '';
    scanRawText.textContent = '';
    if (!scanDialog.open) scanDialog.showModal();
  }

  function updateScanProgress(message) {
    const statusMap = {
      'loading tesseract core': 'Texterkennung wird geladen …',
      'initializing tesseract': 'Texterkennung startet …',
      'loading language traineddata': 'Deutsche Sprache wird geladen …',
      'initializing api': 'Scanner wird vorbereitet …',
      'recognizing text': 'Aufschrift wird gelesen …'
    };
    if (message?.status) scanStatus.textContent = statusMap[message.status] || 'Verpackung wird analysiert …';
    if (typeof message?.progress === 'number') {
      scanProgressBar.style.width = `${Math.max(6, Math.round(message.progress * 100))}%`;
    }
  }

  async function prepareScanImage(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const longest = Math.max(bitmap.width, bitmap.height);
      if (longest <= 1800) {
        bitmap.close?.();
        return file;
      }
      const scale = 1800 / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return await new Promise(resolve => canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', .88));
    } catch (_) {
      return file;
    }
  }

  async function recognizePackage(file) {
    resetScanUi(file);
    let worker = null;
    try {
      const prepared = await prepareScanImage(file);
      worker = await Tesseract.createWorker('deu', 1, { logger: updateScanProgress });
      const result = await worker.recognize(prepared, { rotateAuto: true });
      scanText = String(result?.data?.text || '').trim();
      scanProgressBar.style.width = '100%';
      if (!scanText) throw new Error('Auf der Verpackung konnte kein Text erkannt werden.');
      renderScanMatches();
    } catch (err) {
      console.error('Scanner:', err);
      scanStatus.textContent = err.message || 'Die Verpackung konnte nicht erkannt werden.';
      scanProgressBar.style.width = '0%';
      scanCandidates.innerHTML = `<div class="scan-empty">😕 Kein Text erkannt.<br><span>Versuche ein helleres Foto, halte die Packung gerade und fülle das Bild möglichst mit der Vorderseite.</span></div>`;
      scanResults.classList.remove('hidden');
      scanRawText.textContent = scanText;
    } finally {
      if (worker) await worker.terminate().catch(() => {});
    }
  }

  function renderScanMatches() {
    const scanItems = itemsForActiveLocation(items);
    scanMatches = scanItems
      .map(item => ({ item, score: scoreScanMatch(item, scanText) }))
      .filter(entry => entry.score > 0)
      .sort((a,b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'de'))
      .slice(0, 5);

    if (!scanSelectedItemId && scanMatches.length) scanSelectedItemId = scanMatches[0].item.id;
    scanProgressPanel.classList.add('hidden');
    scanResults.classList.remove('hidden');
    scanRawText.textContent = scanText;

    const proposed = scanMatches.length
      ? `<div class="scan-section-title">Das könnte es sein:</div>${scanMatches.map(({item,score}) => `
          <button class="scan-candidate ${scanSelectedItemId===item.id?'active':''}" data-scan-item="${item.id}" type="button">
            <span><strong>${esc(item.name)}</strong><small>${esc(activeLocation === 'all' ? itemPlaceLabel(item) : categoryName(item.category_id))}</small></span>
            <em>${scanConfidence(score)}</em>
          </button>`).join('')}`
      : `<div class="scan-empty">🤔 Kein eindeutiger Treffer.<br><span>Du kannst den richtigen Artikel unten manuell auswählen.</span></div>`;

    const selected = scanItems.find(item => item.id === scanSelectedItemId);
    const booking = selected ? `
      <div class="scan-booking">
        <div><span class="eyebrow">Ausgewählt</span><strong>${esc(selected.name)}</strong></div>
        <div class="scan-booking-buttons">
          <button class="qty-btn scan-delta" data-scan-delta="-1" type="button">−</button>
          <span class="scan-booking-label">Bestand<br><b>${selected.quantity} ${esc(selected.unit || '')}</b></span>
          <button class="qty-btn scan-delta" data-scan-delta="1" type="button">+</button>
        </div>
        ${Number(selected.package_size || 1) > 1 ? `<button class="secondary-btn scan-pack" type="button">📦 +1 Packung (${selected.package_size})</button>` : ''}
      </div>` : '';

    scanCandidates.innerHTML = `${proposed}
      <label class="scan-fallback-label">Anderen Artikel auswählen
        <select id="scanFallbackSelect">
          <option value="">Bitte auswählen …</option>
          ${scanItems.slice().sort((a,b)=>a.name.localeCompare(b.name,'de')).map(item => `<option value="${item.id}" ${scanSelectedItemId===item.id?'selected':''}>${esc(item.name)} · ${esc(activeLocation === 'all' ? itemPlaceLabel(item) : categoryName(item.category_id))}</option>`).join('')}
        </select>
      </label>
      ${booking}
      <p class="scan-tip">💡 Falls ein Artikel öfter nicht erkannt wird, kannst du unter <b>Bearbeiten → Erkennungsbegriffe</b> Wörter wie „H-Milch“ oder einen Markennamen ergänzen.</p>`;

    document.querySelectorAll('[data-scan-item]').forEach(button => button.onclick = () => {
      scanSelectedItemId = button.dataset.scanItem;
      renderScanMatches();
    });
    const fallback = document.getElementById('scanFallbackSelect');
    if (fallback) fallback.onchange = () => {
      scanSelectedItemId = fallback.value || null;
      renderScanMatches();
    };
    document.querySelectorAll('.scan-delta').forEach(button => button.onclick = async () => {
      const id = scanSelectedItemId;
      if (!id) return;
      scanDialog.close();
      await changeQuantity(id, Number(button.dataset.scanDelta));
    });
    const packBtn = document.querySelector('.scan-pack');
    if (packBtn) packBtn.onclick = async () => {
      const item = items.find(entry => entry.id === scanSelectedItemId);
      if (!item) return;
      scanDialog.close();
      await changeQuantity(item.id, Math.max(1, Number(item.package_size || 1)));
    };
  }

  function renderShopping() {
    const lowItems = itemsForActiveLocation(items)
      .filter(i => i.quantity <= i.min_quantity)
      .sort((a,b) => a.name.localeCompare(b.name,'de'));
    main.innerHTML = `
      ${locationSwitcher()}
      <div class="section-title"><h2>Einkaufsliste</h2><span class="badge">automatisch</span></div>
      <section class="card"><p style="margin:0;color:#71334f">Hier erscheint alles, dessen Bestand den eingestellten Mindestbestand erreicht oder unterschritten hat.</p></section>
      <div class="item-list">
        ${lowItems.length ? lowItems.map(i => `<article class="item-card">
          <div><div class="item-name">${esc(i.name)}</div><div class="item-meta">${esc(activeLocation === 'all' ? itemPlaceLabel(i) : categoryName(i.category_id))} · Noch ${i.quantity} ${esc(i.unit || '')} · Mindestbestand ${i.min_quantity}</div></div>
          <div class="qty-control">
            <button class="qty-btn minus" data-id="${i.id}">−</button>
            <div class="qty">${i.quantity}</div>
            <button class="qty-btn plus" data-id="${i.id}">+</button>
          </div>
        </article>`).join('') : `<div class="card empty">Aktuell ist nichts knapp. 🎉</div>`}
      </div>`;
    bindLocationSwitcher();
    document.querySelectorAll('.minus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, -1));
    document.querySelectorAll('.plus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, 1));
  }

  function renderStatistics() {
    const undone = new Set(movements.filter(m => m.undo_of).map(m => Number(m.undo_of)));
    const scopedItems = itemsForActiveLocation(items);
    const scopedAllItems = itemsForActiveLocation([...items, ...deletedItems]);
    const scopedItemIds = new Set(scopedAllItems.map(item => item.id));
    const stats = scopedItems
      .map(item => ({ item, used: consumption30(item.id) }))
      .filter(entry => entry.used > 0)
      .sort((a,b) => b.used - a.used || a.item.name.localeCompare(b.item.name, 'de'));

    const recent = movements
      .filter(m => m.kind === 'change' && m.delta < 0 && !undone.has(Number(m.id)) && scopedItemIds.has(m.item_id))
      .slice(0, 10);

    const movementItem = movement => scopedAllItems.find(item => item.id === movement.item_id);
    const movementTime = value => new Date(value).toLocaleString('de-DE', {
      day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    });

    main.innerHTML = `
      ${locationSwitcher()}
      <div class="section-title"><h2>Statistik</h2><span class="badge">30 Tage</span></div>
      <section class="card stats-intro">
        <div class="stats-hero-icon">📊</div>
        <div>
          <strong>Verbrauch der letzten 30 Tage</strong>
          <p>Nur echte Entnahmen über den Minus-Button zählen. Rückgängig gemachte Buchungen und Bestandskorrekturen werden nicht als Verbrauch gewertet.</p>
        </div>
      </section>
      <div class="stats-list">
        ${stats.length ? stats.map(({item, used}) => `
          <article class="stat-card">
            <div>
              <div class="item-name">${esc(item.name)}</div>
              <div class="item-meta">${esc(activeLocation === 'all' ? itemPlaceLabel(item) : categoryName(item.category_id))}</div>
            </div>
            <div class="stat-value"><strong>${used}</strong><span>${esc(item.unit || '')}</span><small>verbraucht</small></div>
          </article>`).join('') : `
          <div class="card empty">Noch keine Verbrauchsdaten vorhanden.<br><span class="item-meta">Echte Entnahmen über − erscheinen hier.</span></div>`}
      </div>

      <section class="card" style="margin-top:14px">
        <h2 style="margin-bottom:4px">Letzte Entnahmen</h2>
        <p class="item-meta" style="margin-top:0">War ein Minus-Tipp nur ein Versehen, kannst du ihn hier aus der Statistik herausnehmen.</p>
        ${recent.length ? recent.map(m => {
          const item = movementItem(m);
          const name = item?.name || 'Artikel';
          const unit = item?.unit || '';
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid #f7c6dc">
              <div>
                <strong>${esc(name)} −${Math.abs(Number(m.delta))} ${esc(unit)}</strong>
                <div class="item-meta">${esc(movementTime(m.created_at))} · ${m.is_correction ? 'Bestandskorrektur' : 'Verbrauch'}</div>
              </div>
              <button
                class="small-btn correction-toggle"
                type="button"
                data-movement="${m.id}"
                data-correction="${m.is_correction ? 'false' : 'true'}">
                ${m.is_correction ? 'Wieder als Verbrauch zählen' : 'Als Korrektur markieren'}
              </button>
            </div>`;
        }).join('') : '<p class="empty">Noch keine Entnahmen in den letzten 30 Tagen.</p>'}
      </section>`;

    bindLocationSwitcher();
    document.querySelectorAll('.correction-toggle').forEach(button => {
      button.onclick = () => setMovementCorrection(
        Number(button.dataset.movement),
        button.dataset.correction === 'true'
      );
    });
  }

  async function setMovementCorrection(movementId, isCorrection) {
    const movement = movements.find(m => Number(m.id) === Number(movementId));
    if (!movement) return;
    const previous = Boolean(movement.is_correction);
    movement.is_correction = isCorrection;
    renderStatistics();

    const { error } = await db.rpc('set_stock_movement_correction_v4', {
      p_movement_id: movementId,
      p_is_correction: isCorrection
    });

    if (error) {
      movement.is_correction = previous;
      renderStatistics();
      return toast(error.message);
    }

    await loadData();
    renderApp();
    toast(isCorrection
      ? 'Als Korrektur markiert – zählt nicht mehr als Verbrauch.'
      : 'Buchung zählt wieder als Verbrauch.');
  }

  function renderSettings() {
    const deletedCount = deletedItems.length;
    main.innerHTML = `
      <section class="card">
        <h2>${esc(household.name)} 💗</h2>
        <p style="color:#71334f">Mit diesem Code kann die zweite Person dem gemeinsamen Bestand beitreten:</p>
        <div class="code-box"><span class="code">${esc(household.invite_code)}</span><button id="copyCode" class="secondary-btn">Kopieren</button></div>
      </section>

      <section class="card">
        <h2>🏠 Wohnungen & Kategorien</h2>
        <p class="item-meta">Eure Artikel sind nach Wohnung getrennt. Kategorien gehören immer zu genau einer Wohnung.</p>
        ${locations.map(location => {
          const locationCategories = categoriesForLocation(location.id);
          return `
            <div style="padding:12px 0;border-top:1px solid #f7c6dc">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:7px">
                <strong>🏠 ${esc(locationLabel(location))}</strong>
                <button class="small-btn add-cat-location" data-location="${location.id}" type="button">+ Kategorie</button>
              </div>
              ${locationCategories.length ? locationCategories.map(c => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #fde4ef">
                  <div>
                    <strong>${esc(c.icon || '📦')} ${esc(c.name)}</strong>
                    ${c.description ? `<div class="item-meta">${esc(c.description)}</div>` : ''}
                  </div>
                  <div class="actions">
                    <button class="small-btn edit-cat" data-id="${c.id}" type="button">Bearbeiten</button>
                    <button class="small-btn delete-cat" data-id="${c.id}" type="button">Löschen</button>
                  </div>
                </div>`).join('') : '<p class="empty" style="padding:8px 0">Noch keine Kategorien.</p>'}
            </div>`;
        }).join('')}
      </section>

      <section class="card">
        <h2>🛟 Datensicherung</h2>
        <p class="item-meta">Deine normalen Änderungen werden sofort in Supabase gespeichert. Zusätzlich kannst du hier eine eigene Sicherungsdatei erstellen.</p>
        <div class="actions" style="margin-top:12px">
          <button id="exportBackup" class="primary-btn" type="button">💾 Backup sichern</button>
          <button id="importBackup" class="secondary-btn" type="button">📥 Backup wiederherstellen</button>
        </div>
        <p class="item-meta" style="margin-bottom:0;margin-top:10px">Gesichert werden beide Wohnungen, Kategorien, Artikel, Bestände, Favoriten, Mindestbestände, Packungsgrößen, Erkennungsbegriffe und der Papierkorb.</p>
      </section>

      <section class="card">
        <h2>🗑️ Papierkorb ${deletedCount ? `<span class="badge">${deletedCount}</span>` : ''}</h2>
        <p class="item-meta">Gelöschte Artikel bleiben hier erhalten, bis du sie wiederherstellst. So verschwindet nichts durch einen versehentlichen Lösch-Tipp.</p>
        ${deletedCount ? deletedItems.map(item => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #f7c6dc">
            <div>
              <strong>${esc(item.name)}</strong>
              <div class="item-meta">${esc(itemPlaceLabel(item))} · ${item.quantity} ${esc(item.unit || '')}</div>
            </div>
            <button class="small-btn restore-item" data-id="${item.id}" type="button">Wiederherstellen</button>
          </div>`).join('') : '<p class="empty" style="padding:14px 0">Papierkorb ist leer. ✨</p>'}
      </section>

      <section class="card">
        <h2>Neue Testfunktionen</h2>
        <p class="item-meta">🏠 Zwei Wohnungen · ⭐ Favoriten · ↩️ Rückgängig · 🔎 Suche · 📦 Packungsgrößen · 🔔 Bestandswarnungen</p>
        <p class="item-meta">📊 Der 30-Tage-Verbrauch lässt sich nach Wohnung oder gemeinsam anzeigen.</p>
        <p class="item-meta">📷 Kamera-Scanner (Beta): liest die Aufschrift einer Verpackung und sucht im aktuell gewählten Haushalt.</p>
      </section>`;

    document.getElementById('copyCode').onclick = async () => {
      await navigator.clipboard.writeText(household.invite_code);
      toast('Einladungscode kopiert.');
    };
    document.getElementById('exportBackup').onclick = exportBackup;
    document.getElementById('importBackup').onclick = chooseBackupFile;
    document.querySelectorAll('.add-cat-location').forEach(button => button.onclick = () => {
      activeLocation = button.dataset.location;
      activeCategory = 'all';
      localStorage.setItem(`haushaltsbestand-location-${household.id}`, activeLocation);
      openCategoryDialog();
    });
    document.querySelectorAll('.restore-item').forEach(b => b.onclick = () => restoreDeletedItem(b.dataset.id));
    document.querySelectorAll('.edit-cat').forEach(b => b.onclick = () => openCategoryDialog(categoryById(b.dataset.id)));
    document.querySelectorAll('.delete-cat').forEach(b => b.onclick = () => deleteCategory(b.dataset.id));
  }

  function backupSafeLocation(location) {
    return {
      id: location.id,
      name: location.name,
      icon: location.icon || '🏠',
      sort_order: Number(location.sort_order || 0),
      created_at: location.created_at || null
    };
  }

  function backupSafeCategory(category) {
    return {
      id: category.id,
      location_id: category.location_id,
      name: category.name,
      icon: category.icon || '📦',
      description: category.description || null,
      created_at: category.created_at || null
    };
  }

  function backupSafeItem(item) {
    return {
      id: item.id,
      category_id: item.category_id,
      name: item.name,
      quantity: Number(item.quantity || 0),
      min_quantity: Number(item.min_quantity || 0),
      unit: item.unit || 'Stk.',
      created_at: item.created_at || null,
      updated_at: item.updated_at || null,
      is_favorite: Boolean(item.is_favorite),
      package_size: Math.max(1, Number(item.package_size || 1)),
      recognition_terms: Array.isArray(item.recognition_terms) ? item.recognition_terms : [],
      deleted_at: item.deleted_at || null
    };
  }

  async function exportBackup() {
    try {
      const { data: allItems, error } = await db
        .from('items')
        .select('*')
        .eq('household_id', household.id)
        .order('name');
      if (error) throw error;

      const backup = {
        format: 'haushaltsbestand-backup',
        version: 3,
        exported_at: new Date().toISOString(),
        household_name: household.name,
        locations: locations.map(backupSafeLocation),
        categories: categories.map(backupSafeCategory),
        items: (allItems || []).map(backupSafeItem)
      };

      const text = JSON.stringify(backup, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `Haushaltsbestand-Backup-${date}.json`;
      const file = new File([text], filename, { type:'application/json' });

      if (navigator.share && navigator.canShare?.({ files:[file] })) {
        await navigator.share({
          title: 'Haushaltsbestand Backup',
          text: 'Sicherungsdatei für euren gemeinsamen Haushaltsbestand.',
          files: [file]
        });
        toast('Backup bereit zum Speichern.');
        return;
      }

      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Backup erstellt.');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      toast(err.message || 'Backup konnte nicht erstellt werden.');
    }
  }

  function chooseBackupFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await importBackupFile(file);
    };
    input.click();
  }

  function validateBackup(raw) {
    if (!raw || raw.format !== 'haushaltsbestand-backup' || !Array.isArray(raw.categories) || !Array.isArray(raw.items)) {
      throw new Error('Das ist keine gültige Haushaltsbestand-Sicherungsdatei.');
    }
    if (raw.categories.length > 300 || raw.items.length > 5000 || (Array.isArray(raw.locations) && raw.locations.length > 20)) {
      throw new Error('Die Sicherungsdatei ist ungewöhnlich groß.');
    }

    const vanessa = locations.find(location => location.name === 'Vanessas Haushalt') || locations[0];
    if (!vanessa) throw new Error('Es wurde keine Wohnung gefunden.');

    const locationIdMap = new Map();
    let locationsOut = [];

    if (Array.isArray(raw.locations) && raw.locations.length) {
      locationsOut = raw.locations.map(location => {
        if (!location?.id || !location?.name) throw new Error('Eine Wohnung im Backup ist ungültig.');
        const name = String(location.name).trim().slice(0, 60);
        const existing = locations.find(current => current.name.toLocaleLowerCase('de') === name.toLocaleLowerCase('de'));
        const targetId = existing?.id || String(location.id);
        locationIdMap.set(String(location.id), targetId);
        return {
          id: targetId,
          household_id: household.id,
          name,
          icon: String(location.icon || '🏠').slice(0, 8),
          sort_order: Math.trunc(Number(location.sort_order || 0))
        };
      });
    } else {
      // Backups from v1.5 and older had no apartment layer.
      // They belong to Vanessa, matching the migration of the live data.
      locationIdMap.set('legacy', vanessa.id);
      locationsOut = locations.map(location => ({
        id: location.id,
        household_id: household.id,
        name: location.name,
        icon: location.icon || '🏠',
        sort_order: Math.trunc(Number(location.sort_order || 0))
      }));
    }

    const validLocationIds = new Set(locationsOut.map(location => location.id));
    const categoriesOut = raw.categories.map(category => {
      if (!category?.id || !category?.name) throw new Error('Eine Kategorie im Backup ist ungültig.');
      const sourceLocationId = category.location_id ? String(category.location_id) : 'legacy';
      const mappedLocationId = locationIdMap.get(sourceLocationId) || (validLocationIds.has(sourceLocationId) ? sourceLocationId : vanessa.id);
      return {
        id: String(category.id),
        household_id: household.id,
        location_id: mappedLocationId,
        name: String(category.name).trim().slice(0, 40),
        icon: String(category.icon || '📦').slice(0, 8),
        description: category.description ? String(category.description).trim().slice(0, 160) : null
      };
    });

    const categoryIds = new Set(categoriesOut.map(c => c.id));
    const itemsOut = raw.items.map(item => {
      if (!item?.id || !item?.name || !categoryIds.has(String(item.category_id))) {
        throw new Error('Ein Artikel im Backup ist ungültig oder verweist auf eine fehlende Kategorie.');
      }
      return {
        id: String(item.id),
        household_id: household.id,
        category_id: String(item.category_id),
        name: String(item.name).trim().slice(0, 80),
        quantity: Math.max(0, Math.trunc(Number(item.quantity || 0))),
        min_quantity: Math.max(0, Math.trunc(Number(item.min_quantity || 0))),
        unit: String(item.unit || 'Stk.').trim().slice(0, 20) || 'Stk.',
        is_favorite: Boolean(item.is_favorite),
        package_size: Math.max(1, Math.trunc(Number(item.package_size || 1))),
        recognition_terms: Array.isArray(item.recognition_terms)
          ? item.recognition_terms.map(value => String(value).trim()).filter(Boolean).slice(0, 20)
          : [],
        deleted_at: item.deleted_at ? String(item.deleted_at) : null
      };
    });

    return { locations: locationsOut, categories: categoriesOut, items: itemsOut };
  }

  async function importBackupFile(file) {
    try {
      const raw = JSON.parse(await file.text());
      const backup = validateBackup(raw);
      if (!confirm(`Backup vom ${raw.exported_at ? new Date(raw.exported_at).toLocaleString('de-DE') : 'unbekannten Datum'} wiederherstellen?

Vorhandene passende Kategorien und Artikel werden auf den Stand des Backups gesetzt. Neuere, nicht im Backup enthaltene Artikel bleiben sicherheitshalber erhalten.`)) return;

      if (backup.locations.length) {
        const locationResult = await db.from('inventory_locations').upsert(backup.locations, { onConflict:'id' });
        if (locationResult.error) throw locationResult.error;
      }

      const catResult = await db.from('categories').upsert(backup.categories, { onConflict:'id' });
      if (catResult.error) throw catResult.error;

      // Restore in smaller batches so even larger personal backups stay reliable on mobile.
      for (let i = 0; i < backup.items.length; i += 200) {
        const batch = backup.items.slice(i, i + 200);
        const itemResult = await db.from('items').upsert(batch, { onConflict:'id' });
        if (itemResult.error) throw itemResult.error;
      }

      await loadData();
      renderApp();
      toast(`${backup.items.length} Artikel aus dem Backup wiederhergestellt.`);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Backup konnte nicht wiederhergestellt werden.');
    }
  }

  function openCategoryDialog(category=null) {
    if (!category && activeLocation === 'all') {
      toast('Bitte zuerst Vanessa oder Mika auswählen.');
      return;
    }

    document.getElementById('categoryDialogTitle').textContent = category ? 'Kategorie bearbeiten' : 'Kategorie hinzufügen';
    document.getElementById('categoryId').value = category?.id || '';
    document.getElementById('categoryName').value = category?.name || '';
    document.getElementById('categoryIcon').value = category?.icon || '';
    document.getElementById('categoryDescription').value = category?.description || '';

    if (category?.location_id) activeLocation = category.location_id;
    categoryDialog.showModal();
  }

  function openItemDialog(item=null) {
    const dialogLocationId = item ? itemLocationId(item) : activeLocation;
    if (dialogLocationId === 'all' || !dialogLocationId) {
      toast('Bitte zuerst Vanessa oder Mika auswählen.');
      return;
    }

    const availableCategories = categoriesForLocation(dialogLocationId);
    if (!availableCategories.length) {
      activeLocation = dialogLocationId;
      toast('Bitte zuerst eine Kategorie in dieser Wohnung anlegen.');
      return openCategoryDialog();
    }
    document.getElementById('itemDialogTitle').textContent = item ? 'Artikel bearbeiten' : 'Artikel hinzufügen';
    document.getElementById('itemId').value = item?.id || '';
    document.getElementById('itemName').value = item?.name || '';
    document.getElementById('itemQuantity').value = item?.quantity ?? 1;
    document.getElementById('itemMinimum').value = item?.min_quantity ?? 0;
    document.getElementById('itemUnit').value = item?.unit || 'Stk.';
    document.getElementById('itemPackageSize').value = item?.package_size || 1;
    document.getElementById('itemRecognitionTerms').value = Array.isArray(item?.recognition_terms) ? item.recognition_terms.join(', ') : '';
    const select = document.getElementById('itemCategory');
    select.innerHTML = availableCategories.map(c => `<option value="${c.id}">${esc(c.icon || '📦')} ${esc(c.name)}</option>`).join('');
    select.value = item?.category_id || availableCategories[0].id;
    itemDialog.showModal();
  }

  cancelCategoryBtn.addEventListener('click', () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    categoryDialog.close();
  });

  cancelItemBtn.addEventListener('click', () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    itemDialog.close();
  });

  categoryForm.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();

    const id = document.getElementById('categoryId').value;
    const payload = {
      name: document.getElementById('categoryName').value.trim(),
      icon: document.getElementById('categoryIcon').value.trim() || '📦',
      description: document.getElementById('categoryDescription').value.trim() || null
    };

    const result = id
      ? await db.from('categories').update(payload).eq('id', id)
      : await db.from('categories').insert({
          ...payload,
          household_id: household.id,
          location_id: activeLocation
        });

    if (result.error) return toast(result.error.message);
    categoryDialog.close();
    await loadData();
    renderApp();
    toast(id ? 'Kategorie geändert.' : 'Kategorie angelegt.');
  });

  itemForm.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const id = document.getElementById('itemId').value;
    const desiredQuantity = Number(document.getElementById('itemQuantity').value);
    const payload = {
      household_id: household.id,
      name: document.getElementById('itemName').value.trim(),
      category_id: document.getElementById('itemCategory').value,
      min_quantity: Number(document.getElementById('itemMinimum').value),
      unit: document.getElementById('itemUnit').value.trim() || 'Stk.',
      package_size: Math.max(1, Number(document.getElementById('itemPackageSize').value || 1)),
      recognition_terms: document.getElementById('itemRecognitionTerms').value
        .split(/[,;]/)
        .map(value => value.trim())
        .filter(Boolean)
        .slice(0, 20)
    };

    if (id) {
      const old = items.find(i => i.id === id);
      const result = await db.from('items').update(payload).eq('id', id);
      if (result.error) return toast(result.error.message);
      if (old && desiredQuantity !== old.quantity) {
        const qtyResult = await db.rpc('correct_item_quantity_v4', { p_item_id: id, p_quantity: desiredQuantity });
        if (qtyResult.error) return toast(qtyResult.error.message);
        toast('Bestand korrigiert – zählt nicht als Verbrauch.');
      }
    } else {
      const result = await db.from('items').insert({ ...payload, quantity: desiredQuantity });
      if (result.error) return toast(result.error.message);
    }
    itemDialog.close();
    await loadData();
    renderApp();
  });

  async function deleteCategory(id) {
    if ([...items, ...deletedItems].some(i => i.category_id === id)) return toast('Kategorie enthält noch Artikel oder Artikel im Papierkorb.');
    if (!confirm('Kategorie wirklich löschen?')) return;
    const { error } = await db.from('categories').delete().eq('id', id);
    if (error) return toast(error.message);
    categories = categories.filter(c => c.id !== id);
    renderApp();
  }

  async function subscribeRealtime() {
    if (realtimeChannel) await db.removeChannel(realtimeChannel);
    realtimeChannel = db.channel(`household-${household.id}`)
      .on('postgres_changes', { event:'*', schema:'public', table:'items' }, async () => {
        await loadData(); renderApp();
      })
      .on('postgres_changes', { event:'*', schema:'public', table:'categories' }, async () => {
        await loadData(); renderApp();
      })
      .on('postgres_changes', { event:'*', schema:'public', table:'stock_movements' }, async () => {
        await loadData(); renderApp();
      })
      .on('postgres_changes', { event:'*', schema:'public', table:'inventory_locations' }, async () => {
        await loadData();
        resolveActiveLocation();
        renderApp();
      })
      .subscribe();
  }

  async function bootstrapApp() {
    try {
      await loadHousehold();
      if (!household) return renderNoHousehold();
      await loadData();
      if (await ensureInventoryLocations()) await loadData();
      if (await ensureStandardCategories()) await loadData();
      resolveActiveLocation();
      await subscribeRealtime();
      renderApp();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Daten konnten nicht geladen werden.');
    }
  }

  scanCameraInput.addEventListener('change', async () => {
    const file = scanCameraInput.files?.[0];
    if (file) await recognizePackage(file);
  });
  document.getElementById('scanAgainBtn').onclick = () => {
    scanDialog.close();
    openPackageScanner();
  };
  document.getElementById('scanCloseBtn').onclick = () => scanDialog.close();
  document.getElementById('scanCloseTop').onclick = () => scanDialog.close();
  scanDialog.addEventListener('close', () => {
    if (scanObjectUrl) {
      URL.revokeObjectURL(scanObjectUrl);
      scanObjectUrl = '';
    }
  });

  document.querySelectorAll('.nav-btn').forEach(btn => btn.onclick = () => {
    activeTab = btn.dataset.tab;
    renderApp();
  });

  logoutBtn.onclick = async () => { await db.auth.signOut(); };

  async function init() {
    if (!configured) return renderSetup();
    db = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    const { data } = await db.auth.getSession();
    session = data.session;
    if (session) await bootstrapApp(); else renderAuth();

    db.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;
      household = null; locations = []; categories = []; items = []; deletedItems = []; movements = []; activeLocation = 'all';
      if (session) await bootstrapApp(); else renderAuth();
    });
  }

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
  init();
})();
