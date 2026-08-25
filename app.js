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
  let categories = [];
  let items = [];
  let movements = [];
  let activeTab = 'stock';
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

  async function ensureStandardCategories() {
    const standards = [
      { name:'Kühlschrank', icon:'🧊' },
      { name:'Vorratskammer', icon:'🥫' },
      { name:'Keller', icon:'📦' }
    ];
    const normalized = new Map(categories.map(c => [c.name.toLocaleLowerCase('de'), c]));
    const missing = standards.filter(s => !normalized.has(s.name.toLocaleLowerCase('de')));
    if (missing.length) {
      const { error } = await db.from('categories').insert(missing.map(s => ({ household_id: household.id, ...s })));
      if (error) console.warn('Standardkategorien:', error);
    }
  }

  async function loadData() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [catRes, itemRes, movementRes] = await Promise.all([
      db.from('categories').select('*').eq('household_id', household.id).order('created_at'),
      db.from('items').select('*').eq('household_id', household.id).order('name'),
      db.from('stock_movements').select('id,item_id,delta,kind,undo_of,created_at').eq('household_id', household.id).gte('created_at', since).order('created_at', { ascending:false })
    ]);
    if (catRes.error) throw catRes.error;
    if (itemRes.error) throw itemRes.error;
    if (movementRes.error) throw movementRes.error;
    categories = catRes.data || [];
    items = itemRes.data || [];
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
    const c = categories.find(x => x.id === id);
    return c ? `${c.icon || '📦'} ${c.name}` : 'Ohne Kategorie';
  }

  function consumption30(itemId) {
    const undone = new Set(movements.filter(m => m.undo_of).map(m => Number(m.undo_of)));
    return movements
      .filter(m => m.item_id === itemId && m.kind === 'change' && m.delta < 0 && !undone.has(Number(m.id)))
      .reduce((sum, m) => sum + Math.abs(m.delta), 0);
  }

  function filteredItems() {
    let result = [...items];
    if (activeCategory === 'favorites') result = result.filter(i => i.is_favorite);
    else if (activeCategory !== 'all') result = result.filter(i => i.category_id === activeCategory);
    const q = searchTerm.trim().toLocaleLowerCase('de');
    if (q) result = result.filter(i => i.name.toLocaleLowerCase('de').includes(q));
    result.sort((a,b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name,'de'));
    return result;
  }

  function renderStock() {
    const filtered = filteredItems();
    const lowItems = items.filter(i => i.quantity <= i.min_quantity);
    main.innerHTML = `
      <div class="section-title">
        <h2>Bestand</h2>
        <div class="actions">
          <button id="scanPackageBtn" class="scan-btn" type="button">📷 Scannen <span>Beta</span></button>
          <button id="addCategoryBtn" class="small-btn" type="button">+ Kategorie</button>
          <button id="addItemBtn" class="primary-btn" type="button">+ Artikel</button>
        </div>
      </div>
      ${lowItems.length ? `<div class="alert-card">🔔 ${lowItems.length === 1 ? '1 Artikel ist knapp.' : `${lowItems.length} Artikel sind knapp.`}</div>` : ''}
      <div class="search-wrap"><input id="stockSearch" type="search" placeholder="Artikel suchen …" value="${esc(searchTerm)}" /></div>
      <div class="category-chip-row">
        <button class="category-chip ${activeCategory==='all'?'active':''}" data-cat="all">Alle</button>
        <button class="category-chip ${activeCategory==='favorites'?'active':''}" data-cat="favorites">⭐ Favoriten</button>
        ${categories.map(c => `<button class="category-chip ${activeCategory===c.id?'active':''}" data-cat="${c.id}">${esc(c.icon || '📦')} ${esc(c.name)}</button>`).join('')}
      </div>
      <div class="item-list">
        ${filtered.length ? filtered.map(itemCard).join('') : `<div class="card empty">Keine passenden Artikel gefunden.</div>`}
      </div>`;

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
            <div class="item-meta">${esc(categoryName(item.category_id))} · Mindestbestand ${item.min_quantity} ${esc(item.unit || '')} ${isLow ? '<span class="low">· 🔔 knapp</span>' : ''}</div>
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
    if (!confirm('Artikel wirklich löschen?')) return;
    const { error } = await db.from('items').delete().eq('id', id);
    if (error) return toast(error.message);
    items = items.filter(i => i.id !== id);
    renderApp();
  }

  function openPackageScanner() {
    if (!items.length) return toast('Lege zuerst mindestens einen Artikel an.');
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
    scanMatches = items
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
            <span><strong>${esc(item.name)}</strong><small>${esc(categoryName(item.category_id))}</small></span>
            <em>${scanConfidence(score)}</em>
          </button>`).join('')}`
      : `<div class="scan-empty">🤔 Kein eindeutiger Treffer.<br><span>Du kannst den richtigen Artikel unten manuell auswählen.</span></div>`;

    const selected = items.find(item => item.id === scanSelectedItemId);
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
          ${items.slice().sort((a,b)=>a.name.localeCompare(b.name,'de')).map(item => `<option value="${item.id}" ${scanSelectedItemId===item.id?'selected':''}>${esc(item.name)} · ${esc(categoryName(item.category_id))}</option>`).join('')}
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
    const lowItems = items.filter(i => i.quantity <= i.min_quantity).sort((a,b) => a.name.localeCompare(b.name,'de'));
    main.innerHTML = `
      <div class="section-title"><h2>Einkaufsliste</h2><span class="badge">automatisch</span></div>
      <section class="card"><p style="margin:0;color:#71334f">Hier erscheint alles, dessen Bestand den eingestellten Mindestbestand erreicht oder unterschritten hat.</p></section>
      <div class="item-list">
        ${lowItems.length ? lowItems.map(i => `<article class="item-card">
          <div><div class="item-name">${esc(i.name)}</div><div class="item-meta">Noch ${i.quantity} ${esc(i.unit || '')} · Mindestbestand ${i.min_quantity}</div></div>
          <div class="qty-control">
            <button class="qty-btn minus" data-id="${i.id}">−</button>
            <div class="qty">${i.quantity}</div>
            <button class="qty-btn plus" data-id="${i.id}">+</button>
          </div>
        </article>`).join('') : `<div class="card empty">Aktuell ist nichts knapp. 🎉</div>`}
      </div>`;
    document.querySelectorAll('.minus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, -1));
    document.querySelectorAll('.plus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, 1));
  }

  function renderStatistics() {
    const stats = items
      .map(item => ({ item, used: consumption30(item.id) }))
      .filter(entry => entry.used > 0)
      .sort((a,b) => b.used - a.used || a.item.name.localeCompare(b.item.name, 'de'));

    main.innerHTML = `
      <div class="section-title"><h2>Statistik</h2><span class="badge">30 Tage</span></div>
      <section class="card stats-intro">
        <div class="stats-hero-icon">📊</div>
        <div>
          <strong>Verbrauch der letzten 30 Tage</strong>
          <p>Gezählt werden eure Entnahmen über den Minus-Button. Rückgängig gemachte Buchungen zählen nicht mit.</p>
        </div>
      </section>
      <div class="stats-list">
        ${stats.length ? stats.map(({item, used}) => `
          <article class="stat-card">
            <div>
              <div class="item-name">${esc(item.name)}</div>
              <div class="item-meta">${esc(categoryName(item.category_id))}</div>
            </div>
            <div class="stat-value"><strong>${used}</strong><span>${esc(item.unit || '')}</span><small>verbraucht</small></div>
          </article>`).join('') : `
          <div class="card empty">Noch keine Verbrauchsdaten vorhanden.<br><span class="item-meta">Sobald ihr Bestände mit − verringert, erscheint der Verbrauch hier.</span></div>`}
      </div>`;
  }

  function renderSettings() {
    main.innerHTML = `
      <section class="card">
        <h2>${esc(household.name)} 💗</h2>
        <p style="color:#71334f">Mit diesem Code kann die zweite Person dem Haushalt beitreten:</p>
        <div class="code-box"><span class="code">${esc(household.invite_code)}</span><button id="copyCode" class="secondary-btn">Kopieren</button></div>
      </section>
      <section class="card">
        <h2>Kategorien</h2>
        ${categories.length ? categories.map(c => `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f7c6dc"><span>${esc(c.icon || '📦')} ${esc(c.name)}</span><button class="small-btn delete-cat" data-id="${c.id}">Löschen</button></div>`).join('') : '<p class="empty">Noch keine Kategorien.</p>'}
        <button id="settingsAddCategory" class="secondary-btn" style="margin-top:12px">+ Kategorie hinzufügen</button>
      </section>
      <section class="card">
        <h2>Neue Testfunktionen</h2>
        <p class="item-meta">⭐ Favoriten · ↩️ Rückgängig · 🔎 Suche · 📦 Packungsgrößen · 🔔 Bestandswarnungen</p>
        <p class="item-meta">📊 Der 30-Tage-Verbrauch hat einen eigenen Menüpunkt unten.</p>
        <p class="item-meta">📷 Kamera-Scanner (Beta): liest die Aufschrift einer Verpackung und schlägt passende Artikel vor.</p>
      </section>`;
    document.getElementById('copyCode').onclick = async () => {
      await navigator.clipboard.writeText(household.invite_code);
      toast('Einladungscode kopiert.');
    };
    document.getElementById('settingsAddCategory').onclick = openCategoryDialog;
    document.querySelectorAll('.delete-cat').forEach(b => b.onclick = () => deleteCategory(b.dataset.id));
  }

  function openCategoryDialog() {
    document.getElementById('categoryName').value = '';
    document.getElementById('categoryIcon').value = '';
    categoryDialog.showModal();
  }

  function openItemDialog(item=null) {
    if (!categories.length) {
      toast('Bitte zuerst eine Kategorie anlegen.');
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
    select.innerHTML = categories.map(c => `<option value="${c.id}">${esc(c.icon || '📦')} ${esc(c.name)}</option>`).join('');
    select.value = item?.category_id || categories[0].id;
    itemDialog.showModal();
  }

  categoryForm.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const name = document.getElementById('categoryName').value.trim();
    const icon = document.getElementById('categoryIcon').value.trim() || '📦';
    const { error } = await db.from('categories').insert({ household_id: household.id, name, icon });
    if (error) return toast(error.message);
    categoryDialog.close();
    await loadData();
    renderApp();
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
        const qtyResult = await db.rpc('change_item_quantity_v3', { p_item_id: id, p_delta: desiredQuantity - old.quantity });
        if (qtyResult.error) return toast(qtyResult.error.message);
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
    if (items.some(i => i.category_id === id)) return toast('Kategorie enthält noch Artikel.');
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
      .subscribe();
  }

  async function bootstrapApp() {
    try {
      await loadHousehold();
      if (!household) return renderNoHousehold();
      await loadData();
      await ensureStandardCategories();
      await loadData();
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
      household = null; categories = []; items = []; movements = [];
      if (session) await bootstrapApp(); else renderAuth();
    });
  }

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
  init();
})();
