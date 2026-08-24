(() => {
  const main = document.getElementById('main');
  const bottomNav = document.getElementById('bottomNav');
  const logoutBtn = document.getElementById('logoutBtn');
  const toastEl = document.getElementById('toast');
  const categoryDialog = document.getElementById('categoryDialog');
  const itemDialog = document.getElementById('itemDialog');
  const categoryForm = document.getElementById('categoryForm');
  const itemForm = document.getElementById('itemForm');

  const config = window.APP_CONFIG || {};
  const configured = config.supabaseUrl && config.supabasePublishableKey &&
    !config.supabaseUrl.startsWith('HIER_') && !config.supabasePublishableKey.startsWith('HIER_');

  let db = null;
  let session = null;
  let household = null;
  let categories = [];
  let items = [];
  let activeTab = 'stock';
  let activeCategory = 'all';
  let authMode = 'login';
  let realtimeChannel = null;

  const esc = (value='') => String(value)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#039;');

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 2200);
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
        <h2>Gemeinsamer Bestand</h2>
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

  async function loadData() {
    const [catRes, itemRes] = await Promise.all([
      db.from('categories').select('*').eq('household_id', household.id).order('created_at'),
      db.from('items').select('*').eq('household_id', household.id).order('name')
    ]);
    if (catRes.error) throw catRes.error;
    if (itemRes.error) throw itemRes.error;
    categories = catRes.data || [];
    items = itemRes.data || [];
  }

  function renderApp() {
    bottomNav.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
    if (activeTab === 'stock') renderStock();
    if (activeTab === 'shopping') renderShopping();
    if (activeTab === 'settings') renderSettings();
  }

  function categoryName(id) {
    const c = categories.find(x => x.id === id);
    return c ? `${c.icon || '📦'} ${c.name}` : 'Ohne Kategorie';
  }

  function renderStock() {
    const filtered = activeCategory === 'all' ? items : items.filter(i => i.category_id === activeCategory);
    main.innerHTML = `
      <div class="section-title">
        <h2>Bestand</h2>
        <div class="actions">
          <button id="addCategoryBtn" class="small-btn" type="button">+ Kategorie</button>
          <button id="addItemBtn" class="primary-btn" type="button">+ Artikel</button>
        </div>
      </div>
      <div class="category-chip-row">
        <button class="category-chip ${activeCategory==='all'?'active':''}" data-cat="all">Alle</button>
        ${categories.map(c => `<button class="category-chip ${activeCategory===c.id?'active':''}" data-cat="${c.id}">${esc(c.icon || '📦')} ${esc(c.name)}</button>`).join('')}
      </div>
      <div class="item-list">
        ${filtered.length ? filtered.map(itemCard).join('') : `<div class="card empty">Noch keine Artikel vorhanden.</div>`}
      </div>`;

    document.getElementById('addCategoryBtn').onclick = openCategoryDialog;
    document.getElementById('addItemBtn').onclick = () => openItemDialog();
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { activeCategory = b.dataset.cat; renderStock(); });
    bindItemButtons();
  }

  function itemCard(item) {
    const isLow = item.quantity <= item.min_quantity;
    return `<article class="item-card" data-item="${item.id}">
      <div>
        <div class="item-name">${esc(item.name)}</div>
        <div class="item-meta">${esc(categoryName(item.category_id))} · Mindestbestand ${item.min_quantity} ${esc(item.unit || '')} ${isLow ? '<span class="low">· nachkaufen</span>' : ''}</div>
      </div>
      <div class="qty-control">
        <button class="qty-btn minus" data-id="${item.id}" type="button" aria-label="Bestand verringern">−</button>
        <div class="qty">${item.quantity}<div class="item-meta">${esc(item.unit || '')}</div></div>
        <button class="qty-btn plus" data-id="${item.id}" type="button" aria-label="Bestand erhöhen">+</button>
      </div>
      <div class="item-tools">
        <button class="small-btn edit" data-id="${item.id}" type="button">Bearbeiten</button>
        <button class="small-btn delete" data-id="${item.id}" type="button">Löschen</button>
      </div>
    </article>`;
  }

  function bindItemButtons() {
    document.querySelectorAll('.minus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, -1));
    document.querySelectorAll('.plus').forEach(b => b.onclick = () => changeQuantity(b.dataset.id, 1));
    document.querySelectorAll('.edit').forEach(b => b.onclick = () => openItemDialog(items.find(i => i.id === b.dataset.id)));
    document.querySelectorAll('.delete').forEach(b => b.onclick = () => deleteItem(b.dataset.id));
  }

  async function changeQuantity(id, delta) {
    const item = items.find(x => x.id === id);
    if (!item) return;
    item.quantity = Math.max(0, item.quantity + delta);
    renderApp();
    const { error } = await db.rpc('change_item_quantity', { p_item_id: id, p_delta: delta });
    if (error) {
      toast(error.message);
      await loadData();
      renderApp();
    }
  }

  async function deleteItem(id) {
    if (!confirm('Artikel wirklich löschen?')) return;
    const { error } = await db.from('items').delete().eq('id', id);
    if (error) return toast(error.message);
    items = items.filter(i => i.id !== id);
    renderApp();
  }

  function renderShopping() {
    const lowItems = items.filter(i => i.quantity <= i.min_quantity).sort((a,b) => a.name.localeCompare(b.name,'de'));
    main.innerHTML = `
      <div class="section-title"><h2>Einkaufsliste</h2><span class="badge">automatisch</span></div>
      <section class="card"><p style="margin:0;color:#525252">Hier erscheint alles, dessen Bestand den eingestellten Mindestbestand erreicht oder unterschritten hat.</p></section>
      <div class="item-list">
        ${lowItems.length ? lowItems.map(i => `<article class="item-card">
          <div><div class="item-name">${esc(i.name)}</div><div class="item-meta">Noch ${i.quantity} ${esc(i.unit || '')} · Ziel mindestens ${i.min_quantity + 1}</div></div>
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

  function renderSettings() {
    main.innerHTML = `
      <section class="card">
        <h2>${esc(household.name)}</h2>
        <p style="color:#525252">Mit diesem Code kann die zweite Person dem Haushalt beitreten:</p>
        <div class="code-box"><span class="code">${esc(household.invite_code)}</span><button id="copyCode" class="secondary-btn">Kopieren</button></div>
      </section>
      <section class="card">
        <h2>Kategorien</h2>
        ${categories.length ? categories.map(c => `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #eee"><span>${esc(c.icon || '📦')} ${esc(c.name)}</span><button class="small-btn delete-cat" data-id="${c.id}">Löschen</button></div>`).join('') : '<p class="empty">Noch keine Kategorien.</p>'}
        <button id="settingsAddCategory" class="secondary-btn" style="margin-top:12px">+ Kategorie hinzufügen</button>
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
    const payload = {
      household_id: household.id,
      name: document.getElementById('itemName').value.trim(),
      category_id: document.getElementById('itemCategory').value,
      quantity: Number(document.getElementById('itemQuantity').value),
      min_quantity: Number(document.getElementById('itemMinimum').value),
      unit: document.getElementById('itemUnit').value.trim() || 'Stk.'
    };
    const result = id ? await db.from('items').update(payload).eq('id', id) : await db.from('items').insert(payload);
    if (result.error) return toast(result.error.message);
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
      await subscribeRealtime();
      renderApp();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Daten konnten nicht geladen werden.');
    }
  }

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
      household = null; categories = []; items = [];
      if (session) await bootstrapApp(); else renderAuth();
    });
  }

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
  init();
})();
