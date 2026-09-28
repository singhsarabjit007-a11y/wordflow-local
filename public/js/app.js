const APP_TIME_ZONE = 'Asia/Kolkata';
const NOTIFICATION_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00'];
const MASTER_PROMPT = `Create a WordFlow V1 vocabulary learning pack as a downloadable JSON file.

Topic: [REPLACE WITH WHAT I WANT TO LEARN]
Difficulty: [Everyday professional / Intermediate / Advanced]
Number of items: [10 / 20 / 30]

The vocabulary should be genuinely useful in the requested context. It may include single words, phrasal verbs, business expressions, or sentence patterns. Avoid obvious/basic vocabulary unless it is especially useful.

Return ONLY valid JSON using this exact schema:
{
  "schema_version": 1,
  "pack": {
    "name": "Pack name",
    "description": "Short description",
    "topic": "Topic",
    "difficulty": "Intermediate"
  },
  "items": [
    {
      "term": "align on",
      "type": "phrase",
      "meaning": "A concise meaning.",
      "explanation": "A slightly fuller explanation of nuance and when to use it.",
      "category": "IT Meetings",
      "difficulty": "Intermediate",
      "examples": [
        "Example sentence 1.",
        "Example sentence 2.",
        "Example sentence 3.",
        "Example sentence 4.",
        "Example sentence 5."
      ]
    }
  ]
}

Rules:
- Exactly five natural example sentences per item.
- Examples must fit the requested real-world context.
- Do not include markdown fences, commentary, or text outside the JSON.
- Avoid duplicate terms within the pack.`;

let sb = null;
let config = null;
let session = null;
let currentAssignment = null;
let currentImport = null;
let libraryFilter = 'all';
let libraryCache = [];
let deferredInstallPrompt = null;

const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove('hidden');
const hide = (el) => el?.classList.add('hidden');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  show($('installBtn'));
});

$('installBtn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hide($('installBtn'));
});

async function boot() {
  try {
    if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Missing Netlify public configuration.');
      config = await response.json();
      localStorage.setItem('wordflow-public-config', JSON.stringify(config));
    } catch (networkError) {
      const cached = localStorage.getItem('wordflow-public-config');
      if (!cached) throw networkError;
      config = JSON.parse(cached);
    }
    if (!config.supabaseUrl || !config.supabasePublishableKey || !config.vapidPublicKey) {
      throw new Error('SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and VAPID_PUBLIC_KEY must be configured in Netlify.');
    }

    sb = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const { data } = await sb.auth.getSession();
    session = data.session;
    sb.auth.onAuthStateChange((_event, nextSession) => {
      session = nextSession;
      renderAuthState();
    });

    $('masterPrompt').textContent = MASTER_PROMPT;
    wireEvents();
    renderAuthState();
  } catch (error) {
    console.error(error);
    hide($('bootView'));
    $('setupErrorText').textContent = error.message;
    show($('setupErrorView'));
  }
}

function wireEvents() {
  document.querySelectorAll('[data-nav]').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.nav)));
  $('loginForm').addEventListener('submit', login);
  $('signOutBtn').addEventListener('click', () => sb.auth.signOut());
  $('refreshTodayBtn').addEventListener('click', loadToday);
  $('knowBtn').addEventListener('click', () => setCurrentStatus('learned'));
  $('skipBtn').addEventListener('click', () => setCurrentStatus('review'));
  $('pushBtn').addEventListener('click', enablePush);
  $('disablePushBtn').addEventListener('click', disablePush);
  $('jsonFileInput').addEventListener('change', readFileImport);
  $('previewPasteBtn').addEventListener('click', previewPastedImport);
  $('clearImportBtn').addEventListener('click', clearImportPreview);
  $('importBtn').addEventListener('click', importPack);
  $('copyPromptBtn').addEventListener('click', copyMasterPrompt);
  $('librarySearch').addEventListener('input', renderLibrary);
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    libraryFilter = chip.dataset.filter;
    renderLibrary();
  }));
}

async function renderAuthState() {
  hide($('bootView'));
  hide($('setupErrorView'));
  if (!session) {
    hide($('mainView'));
    hide($('bottomNav'));
    show($('authView'));
    return;
  }

  hide($('authView'));
  show($('mainView'));
  show($('bottomNav'));
  $('accountEmail').textContent = session.user.email || '';
  navigate(location.hash.replace('#', '') || 'today');
  await Promise.allSettled([loadToday(), loadQueue(), loadLibrary(), updatePushStatus()]);
}

async function login(event) {
  event.preventDefault();
  const email = $('emailInput').value.trim();
  const button = event.submitter;
  setBusy(button, true, 'Sending…');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}/` }
  });
  setBusy(button, false, 'Send sign-in link');
  const box = $('authMessage');
  box.className = 'message';
  box.textContent = error ? error.message : 'Check your email for the WordFlow sign-in link.';
  if (error) box.classList.add('error');
  show(box);
}

function navigate(section) {
  if (!session) return;
  const valid = ['today', 'queue', 'library', 'import', 'settings'];
  if (!valid.includes(section)) section = 'today';
  document.querySelectorAll('[data-section]').forEach((s) => s.classList.toggle('hidden', s.dataset.section !== section));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === section));
  history.replaceState(null, '', `#${section}`);
  if (section === 'queue') loadQueue();
  if (section === 'library') loadLibrary();
}

function indiaDateISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function prettyToday() {
  return new Intl.DateTimeFormat('en-IN', { timeZone: APP_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
}

async function loadToday() {
  if (!session) return;
  $('todayDate').textContent = prettyToday();
  const date = indiaDateISO();

  let { data: assignment, error } = await sb
    .from('daily_assignments')
    .select('id, learning_date, vocabulary_item_id, vocabulary_items(id, term, item_type, meaning, explanation, category, difficulty, status, examples(example_index, sentence))')
    .eq('user_id', session.user.id)
    .eq('learning_date', date)
    .maybeSingle();

  if (error) {
    const cached = localStorage.getItem('wordflow-today');
    if (cached) {
      try {
        const snapshot = JSON.parse(cached);
        currentAssignment = { learning_date: snapshot.date, vocabulary_items: snapshot.item };
        hide($('todayEmpty'));
        show($('todayCard'));
        renderToday(currentAssignment);
        showToast('Offline: showing your last saved daily word.');
        return;
      } catch { /* ignore malformed cache */ }
    }
    return showToast(error.message, true);
  }
  if (!assignment) assignment = await createTodayAssignment(date);
  currentAssignment = assignment;

  if (!assignment) {
    hide($('todayCard'));
    show($('todayEmpty'));
    return;
  }
  hide($('todayEmpty'));
  show($('todayCard'));
  renderToday(assignment);
}

async function createTodayAssignment(date) {
  // If yesterday ended without the fifth push, do not leave that item permanently active.
  await sb.from('vocabulary_items')
    .update({ status: 'review' })
    .eq('user_id', session.user.id)
    .eq('status', 'active')
    .lt('started_on', date);

  const { data: next, error } = await sb
    .from('vocabulary_items')
    .select('id, term, item_type, meaning, explanation, category, difficulty, status, examples(example_index, sentence)')
    .eq('user_id', session.user.id)
    .eq('status', 'queued')
    .order('queue_position', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) { showToast(error.message, true); return null; }
  if (!next) return null;

  const { data: inserted, error: insertError } = await sb
    .from('daily_assignments')
    .insert({ user_id: session.user.id, learning_date: date, vocabulary_item_id: next.id })
    .select('id, learning_date, vocabulary_item_id')
    .single();

  if (insertError) {
    // A scheduled notification may have created it milliseconds before us.
    const { data: existing } = await sb
      .from('daily_assignments')
      .select('id, learning_date, vocabulary_item_id, vocabulary_items(id, term, item_type, meaning, explanation, category, difficulty, status, examples(example_index, sentence))')
      .eq('user_id', session.user.id).eq('learning_date', date).maybeSingle();
    return existing || null;
  }

  await sb.from('vocabulary_items').update({ status: 'active', started_on: date }).eq('id', next.id);
  return { ...inserted, vocabulary_items: { ...next, status: 'active' } };
}

function renderToday(assignment) {
  const item = assignment.vocabulary_items;
  if (!item) return;
  $('todayTerm').textContent = item.term;
  $('todayType').textContent = item.item_type;
  $('todayDifficulty').textContent = item.difficulty || 'Unspecified';
  $('todayMeaning').textContent = item.meaning;
  $('todayExplanation').textContent = item.explanation || '';
  $('todayCategory').textContent = item.category || '';
  const list = $('todayExamples');
  list.innerHTML = '';
  [...(item.examples || [])].sort((a,b) => a.example_index - b.example_index).forEach((example) => {
    const li = document.createElement('li');
    li.textContent = example.sentence;
    list.appendChild(li);
  });
  const snapshot = { date: assignment.learning_date, item };
  localStorage.setItem('wordflow-today', JSON.stringify(snapshot));
}

async function setCurrentStatus(status) {
  const item = currentAssignment?.vocabulary_items;
  if (!item) return;
  const updates = { status };
  if (status === 'learned') updates.learned_at = new Date().toISOString();
  const { error } = await sb.from('vocabulary_items').update(updates).eq('id', item.id);
  if (error) return showToast(error.message, true);
  item.status = status;
  showToast(status === 'learned' ? 'Marked as learned.' : 'Moved to review. Tomorrow will use the next queued item.');
  await Promise.all([loadQueue(), loadLibrary()]);
}

async function loadQueue() {
  if (!session) return;
  const { data, error } = await sb
    .from('vocabulary_items')
    .select('id, term, item_type, meaning, category, difficulty, queue_position')
    .eq('user_id', session.user.id)
    .eq('status', 'queued')
    .order('queue_position', { ascending: true });
  if (error) return showToast(error.message, true);
  const target = $('queueList');
  target.innerHTML = '';
  (data || []).forEach((item, idx) => {
    const el = buildListItem(item, `${idx + 1} · ${item.item_type} · ${item.category || 'General'}`);
    const button = miniButton('Learn next', () => moveToTop(item.id));
    el.querySelector('.list-actions').appendChild(button);
    target.appendChild(el);
  });
  $('queueEmpty').classList.toggle('hidden', (data || []).length !== 0);
}

async function moveToTop(id) {
  const topPosition = Date.now() * -1;
  const { error } = await sb.from('vocabulary_items').update({ queue_position: topPosition }).eq('id', id);
  if (error) return showToast(error.message, true);
  showToast('Moved to the top of your queue.');
  loadQueue();
}

async function loadLibrary() {
  if (!session) return;
  const { data, error } = await sb
    .from('vocabulary_items')
    .select('id, term, item_type, meaning, category, difficulty, status, created_at')
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: false });
  if (error) return showToast(error.message, true);
  libraryCache = data || [];
  $('libraryCount').textContent = `${libraryCache.length} item${libraryCache.length === 1 ? '' : 's'}`;
  renderLibrary();
}

function renderLibrary() {
  const query = ($('librarySearch')?.value || '').trim().toLowerCase();
  const filtered = libraryCache.filter((item) => {
    const matchesStatus = libraryFilter === 'all' || item.status === libraryFilter || (libraryFilter === 'review' && item.status === 'active');
    const haystack = `${item.term} ${item.meaning} ${item.category || ''} ${item.item_type}`.toLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });
  const target = $('libraryList');
  target.innerHTML = '';
  filtered.forEach((item) => {
    const el = buildListItem(item, `${item.status} · ${item.item_type} · ${item.category || 'General'}`);
    if (item.status !== 'learned') el.querySelector('.list-actions').appendChild(miniButton('Learned', () => markItemLearned(item.id)));
    target.appendChild(el);
  });
}

async function markItemLearned(id) {
  const { error } = await sb.from('vocabulary_items').update({ status: 'learned', learned_at: new Date().toISOString() }).eq('id', id);
  if (error) return showToast(error.message, true);
  await Promise.all([loadLibrary(), loadQueue()]);
}

function buildListItem(item, meta) {
  const node = $('listItemTemplate').content.cloneNode(true);
  node.querySelector('.list-term').textContent = item.term;
  node.querySelector('.list-meta').textContent = meta;
  node.querySelector('.list-meaning').textContent = item.meaning;
  return node.firstElementChild;
}

function miniButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini-btn';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

async function readFileImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try { previewImport(JSON.parse(await file.text())); }
  catch (error) { showToast(`Invalid JSON file: ${error.message}`, true); }
}

function previewPastedImport() {
  try { previewImport(JSON.parse($('jsonPaste').value)); }
  catch (error) { showToast(`Invalid pasted JSON: ${error.message}`, true); }
}

function validatePack(payload) {
  if (!payload || payload.schema_version !== 1) throw new Error('schema_version must be 1.');
  if (!payload.pack?.name || !Array.isArray(payload.items) || payload.items.length === 0) throw new Error('Pack name and at least one item are required.');
  if (payload.items.length > 200) throw new Error('V1 accepts a maximum of 200 items per import.');
  for (const [index, item] of payload.items.entries()) {
    if (!item.term || !item.type || !item.meaning) throw new Error(`Item ${index + 1} is missing term, type or meaning.`);
    if (!Array.isArray(item.examples) || item.examples.length !== 5 || item.examples.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error(`“${item.term}” must contain exactly five non-empty example sentences.`);
    }
  }
  return payload;
}

function previewImport(payload) {
  currentImport = validatePack(payload);
  $('previewPackName').textContent = currentImport.pack.name;
  $('previewPackMeta').textContent = `${currentImport.items.length} items · ${currentImport.pack.difficulty || 'Mixed difficulty'} · ${currentImport.pack.topic || 'General'}`;
  const target = $('previewTerms');
  target.innerHTML = '';
  currentImport.items.forEach((item) => {
    const pill = document.createElement('span');
    pill.textContent = item.term;
    target.appendChild(pill);
  });
  hide($('importMessage'));
  show($('importPreview'));
}

function clearImportPreview() {
  currentImport = null;
  $('jsonFileInput').value = '';
  $('jsonPaste').value = '';
  hide($('importPreview'));
}

async function importPack() {
  if (!currentImport) return;
  const button = $('importBtn');
  setBusy(button, true, 'Importing…');
  const resultBox = $('importMessage');
  resultBox.className = 'message';

  const { data: pack, error: packError } = await sb.from('learning_packs').insert({
    user_id: session.user.id,
    name: currentImport.pack.name,
    description: currentImport.pack.description || '',
    topic: currentImport.pack.topic || '',
    difficulty: currentImport.pack.difficulty || ''
  }).select('id').single();

  if (packError) {
    setBusy(button, false, 'Import into my queue');
    return showImportError(packError.message);
  }

  const { data: last } = await sb.from('vocabulary_items').select('queue_position').eq('user_id', session.user.id).order('queue_position', { ascending: false }).limit(1).maybeSingle();
  let nextPosition = Math.max(Number(last?.queue_position || 0) + 100, Date.now());
  let imported = 0;
  let skipped = 0;

  for (const item of currentImport.items) {
    const normalized = normalizeTerm(item.term);
    const { data: inserted, error } = await sb.from('vocabulary_items').insert({
      user_id: session.user.id,
      pack_id: pack.id,
      term: item.term.trim(),
      term_normalized: normalized,
      item_type: item.type.trim(),
      meaning: item.meaning.trim(),
      explanation: (item.explanation || '').trim(),
      category: (item.category || currentImport.pack.topic || '').trim(),
      difficulty: (item.difficulty || currentImport.pack.difficulty || '').trim(),
      status: 'queued',
      queue_position: nextPosition
    }).select('id').single();

    if (error) {
      if (error.code === '23505') { skipped++; continue; }
      setBusy(button, false, 'Import into my queue');
      return showImportError(`Import stopped at “${item.term}”: ${error.message}`);
    }

    const examples = item.examples.map((sentence, idx) => ({
      user_id: session.user.id,
      vocabulary_item_id: inserted.id,
      example_index: idx + 1,
      sentence: sentence.trim()
    }));
    const { error: examplesError } = await sb.from('examples').insert(examples);
    if (examplesError) {
      setBusy(button, false, 'Import into my queue');
      return showImportError(`Could not save examples for “${item.term}”: ${examplesError.message}`);
    }
    imported++;
    nextPosition += 100;
  }

  resultBox.textContent = `Imported ${imported} item${imported === 1 ? '' : 's'}${skipped ? `; skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.`;
  show(resultBox);
  setBusy(button, false, 'Import into my queue');
  await Promise.all([loadQueue(), loadLibrary(), loadToday()]);
}

function showImportError(message) {
  const box = $('importMessage');
  box.className = 'message error';
  box.textContent = message;
  show(box);
}

function normalizeTerm(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function copyMasterPrompt() {
  await navigator.clipboard.writeText(MASTER_PROMPT);
  showToast('Prompt copied.');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return showToast('Push notifications are not supported in this browser.', true);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return updatePushStatus();

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
    });
  }
  const json = subscription.toJSON();
  const row = {
    user_id: session.user.id,
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
    user_agent: navigator.userAgent
  };
  const { error } = await sb.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
  if (error) return showToast(error.message, true);
  await sb.from('user_settings').update({ notifications_enabled: true }).eq('user_id', session.user.id);
  showToast('Daily notifications enabled.');
  updatePushStatus();
}

async function disablePush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await sb.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
      await subscription.unsubscribe();
    }
    await sb.from('user_settings').update({ notifications_enabled: false }).eq('user_id', session.user.id);
    showToast('Push notifications disabled.');
    updatePushStatus();
  } catch (error) { showToast(error.message, true); }
}

async function updatePushStatus() {
  if (!session) return;
  let text = `Scheduled: ${NOTIFICATION_TIMES.join(', ')} IST.`;
  let enabled = false;
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    enabled = Notification.permission === 'granted' && !!sub;
  }
  $('pushStatus').textContent = enabled ? `Enabled · ${text}` : `Not enabled · ${text}`;
  $('pushBtn').textContent = enabled ? 'Enabled' : 'Enable';
  $('pushBtn').disabled = enabled;
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function showToast(message, isError = false) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    Object.assign(toast.style, {
      position: 'fixed', left: '50%', bottom: '92px', transform: 'translateX(-50%)',
      zIndex: 99, maxWidth: '92vw', padding: '11px 15px', borderRadius: '12px',
      boxShadow: '0 10px 28px rgba(0,0,0,.12)', fontWeight: 650, fontSize: '.86rem'
    });
    document.body.appendChild(toast);
  }
  toast.style.background = isError ? '#7c3737' : '#274b55';
  toast.style.color = 'white';
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

window.addEventListener('hashchange', () => session && navigate(location.hash.replace('#', '') || 'today'));
boot();
