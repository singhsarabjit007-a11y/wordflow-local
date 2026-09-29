/*
 * WordFlow keeps an offline IndexedDB copy first, then silently syncs it to
 * Supabase when configured. A passwordless email link identifies the same
 * person on each device without asking them to create or remember a password.
 */

const DB_NAME = 'wordflow-local';
const DB_VERSION = 1;
const ITEM_STORE = 'items';
const SETTINGS_STORE = 'settings';
const DEFAULT_REMINDER_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00'];
// Each successful review moves the word to the next gap in this sequence.
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 21, 60];
const VALID_STATUSES = new Set(['queued', 'active', 'review', 'learned']);

const MASTER_PROMPT = `Create a WordFlow vocabulary learning pack as valid JSON.

Topic: [REPLACE WITH A TOPIC]
Difficulty: [Everyday professional / Intermediate / Advanced]
Number of items: [10 / 20 / 30]

Return ONLY JSON with this exact shape:
{
  "schema_version": 1,
  "pack": { "name": "Pack name", "description": "Short description", "topic": "Topic", "difficulty": "Intermediate" },
  "items": [{
    "term": "align on", "type": "phrase", "meaning": "A concise meaning.",
    "explanation": "A fuller explanation of how it is used.", "category": "IT meetings", "difficulty": "Intermediate",
    "examples": ["Example 1.", "Example 2.", "Example 3.", "Example 4.", "Example 5."]
  }]
}

Rules: exactly five natural examples per item; no markdown fences; no text outside JSON.`;

let db;
let settings;
let currentTodayItem = null;
let currentImport = null;
let libraryFilter = 'all';
let reminderTimers = [];
let deferredInstallPrompt = null;
let supabaseClient = null;
let supabaseSession = null;
let cloudReadyForUserId = null;
let cloudActivationForUserId = null;
let cloudSyncTimer = null;
let applyingCloudState = false;

const $ = (id) => document.getElementById(id);
const show = (element) => element?.classList.remove('hidden');
const hide = (element) => element?.classList.add('hidden');
const normalizeTerm = (value) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const todayKey = () => new Date().toLocaleDateString('en-CA');
const addDaysKey = (days) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toLocaleDateString('en-CA'); };
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/* IndexedDB's low-level API is wrapped once so feature code remains readable. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ITEM_STORE)) {
        const items = database.createObjectStore(ITEM_STORE, { keyPath: 'id' });
        items.createIndex('normalizedTerm', 'normalizedTerm', { unique: true });
        items.createIndex('status', 'status');
        items.createIndex('queuePosition', 'queuePosition');
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(storeName, mode = 'readonly') { return db.transaction(storeName, mode).objectStore(storeName); }
function requestValue(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function getAllItems() { return requestValue(transaction(ITEM_STORE).getAll()); }
async function getItem(id) { return requestValue(transaction(ITEM_STORE).get(id)); }
async function saveItem(item) { const result = await requestValue(transaction(ITEM_STORE, 'readwrite').put(item)); recordLocalChange(); return result; }
async function removeItem(id) { const result = await requestValue(transaction(ITEM_STORE, 'readwrite').delete(id)); recordLocalChange(); return result; }
async function getSetting(key) { const row = await requestValue(transaction(SETTINGS_STORE).get(key)); return row?.value; }
async function saveSetting(key, value) { return requestValue(transaction(SETTINGS_STORE, 'readwrite').put({ key, value })); }

function defaultSettings() { return { reminderTimes: DEFAULT_REMINDER_TIMES, todayDate: null, todayItemId: null, remindersEnabled: false, pushEnabled: false, lastChangedAt: null }; }
async function loadSettings() {
  const saved = await getSetting('app');
  settings = { ...defaultSettings(), ...saved };
  // A first launch needs a timestamp; existing local/cloud state must keep its
  // original timestamp so the newer copy can win during reconciliation.
  if (!saved) await persistSettings();
}
async function persistSettings() { settings.lastChangedAt = new Date().toISOString(); await saveSetting('app', settings); queueCloudSync(); }

function recordLocalChange() {
  // During a download from Supabase, do not immediately upload that same state.
  if (applyingCloudState || !settings) return;
  settings.lastChangedAt = new Date().toISOString();
  void saveSetting('app', settings);
  queueCloudSync();
}

async function upgradeStoredItems() {
  // Existing V1 users keep their data when new optional fields are introduced.
  for (const item of await getAllItems()) {
    if (item.isFavorite === undefined || item.reviewStage === undefined || item.reviewDueDate === undefined) {
      await saveItem({ isFavorite: false, reviewStage: null, reviewDueDate: null, ...item });
    }
  }
}

function setCloudStatus(message, isError = false) {
  const status = $('cloudStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error-text', isError);
}

// The app stays behind this small gate until Supabase knows whose private
// cloud record it should read. This UI never deletes the offline copy.
function showAuthGate(message = '', isError = false) {
  hide($('appContent'));
  hide($('bottomNav'));
  show($('authGate'));
  if (message) setAuthMessage(message, isError);
}

function showApplication() {
  hide($('authGate'));
  show($('appContent'));
  show($('bottomNav'));
}

function setAuthMessage(message, isError = false) {
  const status = $('authMessage');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error-text', isError);
}

async function getCloudConfig() {
  try {
    // A distinct endpoint keeps this version independent of the legacy
    // `config` function that an older Netlify deploy may still retain.
    const response = await fetch('/api/cloud-sync-config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Cloud configuration is unavailable.');
    const config = await response.json();
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error('Cloud configuration is incomplete.');
    localStorage.setItem('wordflow-cloud-config', JSON.stringify(config));
    return config;
  } catch (error) {
    // A previously received public config lets the PWA reconnect after an
    // offline launch. It contains no secret and is safe to cache locally.
    const cached = localStorage.getItem('wordflow-cloud-config');
    if (cached) return JSON.parse(cached);
    return null;
  }
}

// The VAPID public key identifies WordFlow to the browser push service. Unlike
// the private VAPID key, it is designed to be sent to the installed PWA.
async function getPushConfig() {
  const response = await fetch('/api/push-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Push notification configuration is unavailable.');
  const config = await response.json();
  if (!config.vapidPublicKey) throw new Error('Push notification configuration is incomplete.');
  return config;
}

async function initializeCloudSync() {
  const config = await getCloudConfig();
  if (!config) {
    setCloudStatus('Cloud sync is not configured. Your data remains on this device.', true);
    showAuthGate('Cloud setup needs attention. Please try again after the site is configured.', true);
    return false;
  }
  if (!window.supabase) {
    setCloudStatus('Cloud sync library could not load. Working offline.', true);
    showAuthGate('Cloud sign-in could not load. Please refresh and try again.', true);
    return false;
  }

  try {
    setCloudStatus('Connecting your private backup…');
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      // Supabase reads and safely removes the one-time magic-link token after
      // the browser returns here. Subsequent launches use its saved session.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data: current, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError) throw sessionError;
    supabaseSession = current.session;

    // This also catches a successful magic-link return without requiring a
    // page refresh. An expired session simply reveals the sign-in gate.
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      supabaseSession = session;
      if (!session) {
        cloudReadyForUserId = null;
        showAuthGate('Enter your email to continue syncing your WordFlow library.');
        return;
      }
      void activateCloudSession();
    });

    if (!supabaseSession) {
      setCloudStatus('Sign in to sync your library across devices.');
      showAuthGate('Enter your email and we’ll send a secure sign-in link.');
      return false;
    }
    return activateCloudSession();
  } catch (error) {
    console.warn('WordFlow cloud sync unavailable:', error);
    setCloudStatus('Cloud setup needs attention. WordFlow is still working locally.', true);
    showAuthGate('Cloud sign-in is unavailable. Please refresh and try again.', true);
    return false;
  }
}

async function activateCloudSession() {
  const userId = supabaseSession?.user?.id;
  if (!userId || cloudReadyForUserId === userId || cloudActivationForUserId === userId) return Boolean(cloudReadyForUserId === userId);
  cloudActivationForUserId = userId;

  try {
    setCloudStatus('Syncing your private library…');
    await reconcileCloudState();
    // Ignore a slow response if the user changed accounts during that request.
    if (supabaseSession?.user?.id !== userId) return false;
    cloudReadyForUserId = userId;
    if (settings.pushEnabled) void syncPushSubscription();
    setCloudStatus('Cloud sync is active for your account.');
  } catch (error) {
    // A valid login must not lock a person out of their offline data if the
    // network or Supabase is temporarily unavailable.
    console.warn('WordFlow cloud reconciliation failed:', error);
    setCloudStatus('Cloud sync needs attention. Your local copy is still available.', true);
  } finally {
    if (cloudActivationForUserId === userId) cloudActivationForUserId = null;
  }

  showApplication();
  scheduleReminders();
  navigate(location.hash.slice(1) || 'today');
  return true;
}

async function sendMagicLink(event) {
  event.preventDefault();
  const email = $('emailInput').value.trim();
  if (!email) return;
  if (!supabaseClient) {
    setAuthMessage('Cloud configuration is still loading. Please wait a moment and try again.', true);
    return;
  }

  const button = $('magicLinkBtn');
  button.disabled = true;
  setAuthMessage('Sending your secure sign-in link…');
  try {
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      // This must match the Site URL / Redirect URLs configured in Supabase.
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw error;
    setAuthMessage('Check your inbox and open the WordFlow sign-in link on this device.');
  } catch (error) {
    console.warn('WordFlow magic link could not be sent:', error);
    setAuthMessage(error.message || 'We could not send that sign-in link. Please try again.', true);
  } finally {
    button.disabled = false;
  }
}

function queueCloudSync(delay = 700) {
  if (applyingCloudState || !supabaseClient || !supabaseSession) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => { void uploadCloudState(); }, delay);
}

async function uploadCloudState() {
  if (!supabaseClient || !supabaseSession || applyingCloudState) return;
  const payload = { items: await getAllItems(), settings };
  const { error } = await supabaseClient.from('wordflow_device_state').upsert({ user_id: supabaseSession.user.id, payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) { console.warn('WordFlow cloud upload failed:', error); setCloudStatus('Cloud sync could not save. Working locally.', true); return; }
  setCloudStatus(`Cloud sync active · saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
}

async function reconcileCloudState() {
  const { data, error } = await supabaseClient.from('wordflow_device_state').select('payload, updated_at').eq('user_id', supabaseSession.user.id).maybeSingle();
  if (error) throw error;
  const remoteChangedAt = Date.parse(data?.payload?.settings?.lastChangedAt || data?.updated_at || 0);
  const localChangedAt = Date.parse(settings.lastChangedAt || 0);
  const localItems = await getAllItems();
  // A fresh phone creates a local settings timestamp before it receives its
  // session. If it has no vocabulary yet, prefer the existing cloud library.
  if (Array.isArray(data?.payload?.items) && (localItems.length === 0 || remoteChangedAt > localChangedAt)) await applyCloudState(data.payload);
  else await uploadCloudState();
}

async function applyCloudState(payload) {
  if (!Array.isArray(payload.items) || !payload.settings) throw new Error('Cloud backup has an invalid format.');
  applyingCloudState = true;
  try {
    await requestValue(transaction(ITEM_STORE, 'readwrite').clear());
    // Direct writes intentionally bypass saveItem so this download does not
    // trigger a competing upload while it is still being applied.
    for (const item of payload.items) await requestValue(transaction(ITEM_STORE, 'readwrite').put(item));
    settings = { ...defaultSettings(), ...payload.settings };
    await saveSetting('app', settings);
    createReminderTimeFields();
    scheduleReminders();
    if (settings.pushEnabled) void syncPushSubscription();
    await Promise.all([loadToday(), renderQueue(), renderReviews(), renderLibrary(), updateNotificationStatus()]);
  } finally {
    applyingCloudState = false;
  }
}

function createManualExampleFields() {
  const container = $('manualExamples');
  container.replaceChildren();
  for (let index = 1; index <= 5; index += 1) {
    const input = document.createElement('input');
    input.id = `manualExample${index}`;
    input.required = true;
    input.maxLength = 600;
    input.placeholder = `Example sentence ${index}`;
    input.setAttribute('aria-label', `Example sentence ${index}`);
    container.appendChild(input);
  }
}

function createReminderTimeFields() {
  const container = $('reminderTimes');
  container.replaceChildren();
  settings.reminderTimes.forEach((time, index) => {
    const label = document.createElement('label');
    label.textContent = `Reminder ${index + 1}`;
    const input = document.createElement('input');
    input.type = 'time'; input.value = time; input.required = true; input.dataset.reminderTime = String(index);
    label.appendChild(input); container.appendChild(label);
  });
}

function wireEvents() {
  $('magicLinkForm').addEventListener('submit', sendMagicLink);
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $('refreshTodayBtn').addEventListener('click', () => loadToday());
  $('knowBtn').addEventListener('click', () => updateTodayStatus('learned'));
  $('reviewBtn').addEventListener('click', () => updateTodayStatus('review'));
  $('nextWordBtn').addEventListener('click', advanceToNextWord);
  $('speakBtn').addEventListener('click', pronounceTodayWord);
  $('favoriteBtn').addEventListener('click', () => currentTodayItem && toggleFavorite(currentTodayItem));
  $('notificationBtn').addEventListener('click', enableNotifications);
  $('addWordForm').addEventListener('submit', addManualWord);
  $('jsonFileInput').addEventListener('change', readFileImport);
  $('previewPasteBtn').addEventListener('click', previewPastedImport);
  $('importBtn').addEventListener('click', importPack);
  $('copyPromptBtn').addEventListener('click', copyMasterPrompt);
  $('librarySearch').addEventListener('input', renderLibrary);
  $('settingsForm').addEventListener('submit', saveReminderTimes);
  $('exportBtn').addEventListener('click', exportBackup);
  $('restoreFileInput').addEventListener('change', restoreBackup);
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach((button) => button.classList.remove('active'));
    chip.classList.add('active'); libraryFilter = chip.dataset.filter; renderLibrary();
  }));
}

function navigate(section) {
  const allowed = ['today', 'queue', 'review', 'library', 'add', 'import', 'settings'];
  const target = allowed.includes(section) ? section : 'today';
  document.querySelectorAll('[data-section]').forEach((element) => element.classList.toggle('hidden', element.dataset.section !== target));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.nav === target));
  history.replaceState(null, '', `#${target}`);
  if (target === 'today') loadToday();
  if (target === 'queue') renderQueue();
  if (target === 'review') renderReviews();
  if (target === 'library') renderLibrary();
  if (target === 'settings') createReminderTimeFields();
}

async function ensureTodayItem() {
  const date = todayKey();
  // A new date releases yesterday's unfinished active word into review. The
  // selected word is stable for the whole day, even after marking it learned.
  const isNewDay = settings.todayDate !== date;
  if (isNewDay) {
    if (settings.todayItemId) {
      const previous = await getItem(settings.todayItemId);
      if (previous?.status === 'active') await saveItem({ ...previous, status: 'review' });
    }
  }
  // If the user opens an empty app in the morning and adds words later, choose
  // the first one immediately instead of making them wait for the next day.
  if (isNewDay || !settings.todayItemId) {
    const queued = (await getAllItems()).filter((item) => item.status === 'queued').sort((a, b) => a.queuePosition - b.queuePosition)[0];
    settings.todayDate = date; settings.todayItemId = queued?.id || null;
    if (queued) await saveItem({ ...queued, status: 'active', startedOn: date });
    await persistSettings();
  }
  return settings.todayItemId ? getItem(settings.todayItemId) : null;
}

async function loadToday() {
  $('todayDate').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  currentTodayItem = await ensureTodayItem();
  if (!currentTodayItem) { hide($('todayCard')); show($('todayEmpty')); await updateNotificationStatus(); return; }
  hide($('todayEmpty')); show($('todayCard'));
  $('todayType').textContent = currentTodayItem.type;
  $('todayDifficulty').textContent = currentTodayItem.difficulty || 'Personal queue';
  $('todayTerm').textContent = currentTodayItem.term;
  $('todayMeaning').textContent = currentTodayItem.meaning;
  $('todayExplanation').textContent = currentTodayItem.explanation || '';
  $('todayCategory').textContent = currentTodayItem.category || '';
  $('todayExamples').replaceChildren(...currentTodayItem.examples.map((example) => { const item = document.createElement('li'); item.textContent = example; return item; }));
  $('knowBtn').textContent = currentTodayItem.reviewStage !== null ? '✓ Review plan set' : '✓ I know this';
  $('reviewBtn').textContent = currentTodayItem.status === 'review' ? 'In review' : 'Review later';
  $('favoriteBtn').textContent = currentTodayItem.isFavorite ? '★ Saved' : '☆ Save';
  // Do not force people to wait until tomorrow once they have finished today’s word.
  currentTodayItem.status === 'review' || currentTodayItem.status === 'learned' ? show($('nextWordBtn')) : hide($('nextWordBtn'));
  await updateNotificationStatus();
}

async function updateTodayStatus(status) {
  if (!currentTodayItem) return;
  let updated = { ...currentTodayItem, status };
  if (status === 'learned') updated = scheduleFirstReview(updated);
  // "Review later" keeps an item visible in the review tab today without
  // changing the spaced-repetition stage that it may receive later.
  if (status === 'review') updated = { ...updated, reviewDueDate: todayKey(), reviewStage: null };
  await saveItem(updated); currentTodayItem = updated;
  showToast(status === 'learned' ? 'Added to your 1, 3, 7, 21, 60-day review plan.' : 'Added to your review list.');
  await Promise.all([loadToday(), renderQueue(), renderReviews(), renderLibrary()]);
}

async function advanceToNextWord() {
  if (!currentTodayItem || !['review', 'learned'].includes(currentTodayItem.status)) return;
  // Clearing only the current assignment preserves every completed/review item
  // and makes ensureTodayItem select the next queued word on this same date.
  settings.todayItemId = null;
  await persistSettings();
  await Promise.all([loadToday(), renderQueue(), renderLibrary()]);
  showToast(currentTodayItem ? 'Next word is ready.' : 'Your learning queue is empty.');
}

function scheduleFirstReview(item) {
  return { ...item, status: 'review', learnedAt: new Date().toISOString(), reviewStage: 0, reviewDueDate: addDaysKey(REVIEW_INTERVALS_DAYS[0]) };
}

function buildItem(raw, queuePosition) {
  return { id: uid(), term: raw.term.trim(), normalizedTerm: normalizeTerm(raw.term), type: raw.type.trim(), meaning: raw.meaning.trim(), explanation: (raw.explanation || '').trim(), category: (raw.category || '').trim(), difficulty: (raw.difficulty || '').trim(), examples: raw.examples.map((example) => example.trim()), status: 'queued', queuePosition, createdAt: new Date().toISOString(), startedOn: null, learnedAt: null, isFavorite: false, reviewStage: null, reviewDueDate: null };
}

async function addManualWord(event) {
  event.preventDefault();
  const raw = { term: $('addTerm').value, type: $('addType').value, meaning: $('addMeaning').value, explanation: $('addExplanation').value, category: $('addCategory').value, difficulty: $('addDifficulty').value, examples: [1, 2, 3, 4, 5].map((number) => $(`manualExample${number}`).value) };
  try {
    validateItem(raw, 'This word');
    if ((await getAllItems()).some((item) => item.normalizedTerm === normalizeTerm(raw.term))) throw new Error('That word is already in your library.');
    await saveItem(buildItem(raw, Date.now())); event.target.reset(); showToast('Added to your learning queue.'); await loadToday(); navigate('today');
  } catch (error) { showToast(error.message, true); }
}

function validateItem(item, name = 'Item') {
  if (!item?.term?.trim() || !item.type?.trim() || !item.meaning?.trim()) throw new Error(`${name} needs a term, type and meaning.`);
  if (!Array.isArray(item.examples) || item.examples.length !== 5 || item.examples.some((example) => typeof example !== 'string' || !example.trim())) throw new Error(`${name} needs exactly five non-empty example sentences.`);
}

function validatePack(payload) {
  if (payload?.schema_version !== 1 || !payload.pack?.name || !Array.isArray(payload.items) || !payload.items.length) throw new Error('This is not a valid WordFlow pack.');
  if (payload.items.length > 200) throw new Error('A pack can contain at most 200 items.');
  payload.items.forEach((item, index) => validateItem(item, `Item ${index + 1}`)); return payload;
}

async function readFileImport(event) { const file = event.target.files?.[0]; if (!file) return; try { previewImport(JSON.parse(await file.text())); } catch (error) { showToast(`Could not read that JSON: ${error.message}`, true); } }
function previewPastedImport() { try { previewImport(JSON.parse($('jsonPaste').value)); } catch (error) { showToast(`Could not read that JSON: ${error.message}`, true); } }
function previewImport(payload) {
  currentImport = validatePack(payload);
  $('previewPackName').textContent = currentImport.pack.name;
  $('previewPackMeta').textContent = `${currentImport.items.length} items · ${currentImport.pack.difficulty || 'Mixed difficulty'} · ${currentImport.pack.topic || 'General'}`;
  $('previewTerms').replaceChildren(...currentImport.items.map((item) => { const chip = document.createElement('span'); chip.textContent = item.term; return chip; }));
  hide($('importMessage')); show($('importPreview'));
}

async function importPack() {
  if (!currentImport) return;
  const existing = new Set((await getAllItems()).map((item) => item.normalizedTerm));
  let imported = 0; let skipped = 0; let position = Date.now();
  for (const raw of currentImport.items) {
    const normalized = normalizeTerm(raw.term);
    if (existing.has(normalized)) { skipped += 1; continue; }
    await saveItem(buildItem({ ...raw, category: raw.category || currentImport.pack.topic, difficulty: raw.difficulty || currentImport.pack.difficulty }, position));
    existing.add(normalized); imported += 1; position += 1;
  }
  $('importMessage').className = 'message'; $('importMessage').textContent = `Imported ${imported} word${imported === 1 ? '' : 's'}${skipped ? `; skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.`; show($('importMessage'));
  await Promise.all([loadToday(), renderQueue(), renderLibrary()]);
}

function makeListRow(item, actions = []) {
  const row = document.createElement('article'); row.className = 'list-item';
  const main = document.createElement('div'); main.className = 'list-main';
  const term = document.createElement('div'); term.className = 'list-term'; term.textContent = item.term;
  const meta = document.createElement('div'); meta.className = 'list-meta'; meta.textContent = `${item.type} · ${item.status}`;
  const meaning = document.createElement('div'); meaning.className = 'list-meaning'; meaning.textContent = item.meaning;
  main.append(term, meta, meaning); row.appendChild(main);
  if (actions.length) {
    const actionGroup = document.createElement('div'); actionGroup.className = 'list-actions';
    actions.forEach(({ label, action }) => { const button = document.createElement('button'); button.className = 'mini-btn'; button.textContent = label; button.addEventListener('click', action); actionGroup.appendChild(button); });
    row.appendChild(actionGroup);
  }
  return row;
}

async function renderQueue() {
  const items = (await getAllItems()).filter((item) => item.status === 'queued').sort((a, b) => a.queuePosition - b.queuePosition);
  $('queueList').replaceChildren(...items.map((item) => makeListRow(item, [{ label: 'Remove', action: async () => { await removeItem(item.id); showToast('Removed from the queue.'); renderQueue(); renderLibrary(); } }])));
  items.length ? hide($('queueEmpty')) : show($('queueEmpty'));
}

async function renderLibrary() {
  const query = $('librarySearch').value.trim().toLocaleLowerCase();
  const all = await getAllItems();
  const visible = all.filter((item) => (libraryFilter === 'all' || (libraryFilter === 'favorite' ? item.isFavorite : item.status === libraryFilter)) && `${item.term} ${item.meaning} ${item.category} ${item.explanation} ${item.type} ${item.difficulty}`.toLocaleLowerCase().includes(query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('libraryCount').textContent = `${all.length} word${all.length === 1 ? '' : 's'}`;
  $('libraryList').replaceChildren(...visible.map((item) => makeListRow(item, [
    { label: item.isFavorite ? '★' : '☆', action: () => toggleFavorite(item) },
    { label: item.status === 'learned' ? 'Learn again' : 'Set review plan', action: async () => { await saveItem(item.status === 'learned' ? { ...item, status: 'review', reviewStage: null, reviewDueDate: todayKey() } : scheduleFirstReview(item)); renderLibrary(); renderReviews(); renderQueue(); loadToday(); } }
  ])));
}

async function toggleFavorite(item) {
  const updated = { ...item, isFavorite: !item.isFavorite };
  await saveItem(updated);
  if (currentTodayItem?.id === updated.id) currentTodayItem = updated;
  showToast(updated.isFavorite ? 'Saved to favorites.' : 'Removed from favorites.');
  await Promise.all([loadToday(), renderLibrary()]);
}

async function renderReviews() {
  const due = (await getAllItems()).filter((item) => item.status === 'review' && item.reviewDueDate && item.reviewDueDate <= todayKey()).sort((a, b) => a.reviewDueDate.localeCompare(b.reviewDueDate));
  $('reviewCount').textContent = `${due.length} due`;
  $('reviewList').replaceChildren(...due.map((item) => makeListRow(item, [{ label: 'Reviewed', action: () => completeReview(item) }])));
  due.length ? hide($('reviewEmpty')) : show($('reviewEmpty'));
}

async function completeReview(item) {
  const nextStage = (item.reviewStage ?? -1) + 1;
  const updated = nextStage >= REVIEW_INTERVALS_DAYS.length
    ? { ...item, status: 'learned', reviewStage: nextStage, reviewDueDate: null, learnedAt: new Date().toISOString() }
    : { ...item, status: 'review', reviewStage: nextStage, reviewDueDate: addDaysKey(REVIEW_INTERVALS_DAYS[nextStage]) };
  await saveItem(updated);
  showToast(updated.status === 'learned' ? 'Review plan complete — word learned.' : `Next review: ${updated.reviewDueDate}.`);
  await Promise.all([renderReviews(), renderLibrary(), loadToday()]);
}

function pronounceTodayWord() {
  if (!currentTodayItem || !('speechSynthesis' in window)) return showToast('Pronunciation is not supported in this browser.', true);
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(currentTodayItem.term);
  utterance.lang = 'en-US'; utterance.rate = 0.82;
  window.speechSynthesis.speak(utterance);
}

function urlBase64ToUint8Array(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function deviceTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

async function syncPushSubscription() {
  if (!settings.pushEnabled || !supabaseClient || !supabaseSession || Notification.permission !== 'granted') return false;
  if (!('PushManager' in window) || !navigator.serviceWorker) return false;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  const { error } = await supabaseClient.from('wordflow_push_subscriptions').upsert({
    endpoint: subscription.endpoint,
    user_id: supabaseSession.user.id,
    subscription: subscription.toJSON(),
    reminder_times: settings.reminderTimes,
    timezone: deviceTimeZone(),
    active: true,
    updated_at: new Date().toISOString()
  }, { onConflict: 'endpoint' });
  if (error) throw error;
  return true;
}

async function enableNotifications() {
  if (!('Notification' in window) || !('PushManager' in window) || !navigator.serviceWorker) return showToast('This browser does not support closed-app push notifications.', true);
  if (!supabaseClient || !supabaseSession) return showToast('Cloud sync must be active before enabling closed-app reminders.', true);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return showToast('Notification permission was not granted.', true);
  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { vapidPublicKey } = await getPushConfig();
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
    }
    settings.remindersEnabled = true;
    settings.pushEnabled = true;
    await persistSettings();
    await syncPushSubscription();
    scheduleReminders();
    await updateNotificationStatus();
    showToast('Closed-app reminders are enabled for this device.');
  } catch (error) {
    console.warn('WordFlow push subscription failed:', error);
    settings.pushEnabled = false;
    await persistSettings();
    await updateNotificationStatus();
    showToast('Could not enable closed-app reminders. Check the push setup and try again.', true);
  }
}

async function updateNotificationStatus() {
  const enabled = settings.pushEnabled && globalThis.Notification?.permission === 'granted';
  $('notificationBtn').textContent = enabled ? 'Enabled' : 'Enable';
  $('notificationBtn').disabled = enabled;
  $('notificationStatus').textContent = enabled ? `Closed-app reminders enabled · ${settings.reminderTimes.join(', ')}` : `Not enabled · ${settings.reminderTimes.join(', ')}`;
}

function scheduleReminders() {
  reminderTimers.forEach(clearTimeout); reminderTimers = [];
  // A subscribed device receives server push even while closed. Retaining this
  // lightweight fallback helps a local-only/offline copy still remind users.
  if (settings.pushEnabled) return;
  if (!settings.remindersEnabled || Notification.permission !== 'granted') return;
  settings.reminderTimes.forEach((time, index) => {
    const [hour, minute] = time.split(':').map(Number); const next = new Date(); next.setHours(hour, minute, 0, 0); if (next <= new Date()) next.setDate(next.getDate() + 1);
    reminderTimers.push(setTimeout(async () => { await showReminder(index); scheduleReminders(); }, next - Date.now()));
  });
}

async function showReminder(exampleIndex) {
  const item = await ensureTodayItem(); if (!item) return;
  const options = { body: item.examples[exampleIndex] || item.meaning, icon: '/icons/icon-192.png', tag: `wordflow-${todayKey()}-${exampleIndex}`, data: { url: '/#today' } };
  const registration = await navigator.serviceWorker?.ready;
  if (registration) registration.showNotification(`${item.term} — example ${exampleIndex + 1}`, options); else new Notification(item.term, options);
}

async function saveReminderTimes(event) {
  event.preventDefault(); const times = [...document.querySelectorAll('[data-reminder-time]')].map((input) => input.value);
  if (times.some((time) => !/^\d{2}:\d{2}$/.test(time) || Number(time.slice(3)) % 5 !== 0) || new Set(times).size !== 5) return showToast('Choose five different times on five-minute boundaries.', true);
  settings.reminderTimes = times.sort(); await persistSettings(); scheduleReminders();
  try { await syncPushSubscription(); } catch (error) { console.warn('Could not update push reminder times:', error); }
  await updateNotificationStatus(); showToast('Reminder times saved.');
}

async function exportBackup() {
  const backup = { wordflowBackupVersion: 1, exportedAt: new Date().toISOString(), settings, items: await getAllItems() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `wordflow-backup-${todayKey()}.json`; link.click(); URL.revokeObjectURL(url); showBackupMessage('Backup downloaded. Keep it somewhere safe.');
}

async function restoreBackup(event) {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.wordflowBackupVersion !== 1 || !Array.isArray(backup.items) || !backup.settings) throw new Error('This is not a WordFlow backup.');
    if (!window.confirm('Restore this backup? It will replace the WordFlow data on this device.')) return;
    // Each helper uses its own short transaction. This avoids reusing an
    // IndexedDB transaction after an awaited operation has completed it.
    await requestValue(transaction(ITEM_STORE, 'readwrite').clear());
    for (const item of backup.items) {
      if (!VALID_STATUSES.has(item.status)) throw new Error('The backup contains an invalid item status.');
      await saveItem(item);
    }
    settings = { ...defaultSettings(), ...backup.settings }; await persistSettings(); createReminderTimeFields(); scheduleReminders(); await Promise.all([loadToday(), renderQueue(), renderLibrary(), updateNotificationStatus()]); showBackupMessage('Backup restored successfully.');
  } catch (error) { showBackupMessage(error.message, true); } finally { event.target.value = ''; }
}

function showBackupMessage(message, isError = false) { $('backupMessage').className = `message${isError ? ' error' : ''}`; $('backupMessage').textContent = message; show($('backupMessage')); }
async function copyMasterPrompt() { try { await navigator.clipboard.writeText(MASTER_PROMPT); showToast('Prompt copied.'); } catch { showToast('Could not copy the prompt.', true); } }
function showToast(message, isError = false) { let toast = $('globalToast'); if (!toast) { toast = document.createElement('div'); toast.id = 'globalToast'; document.body.appendChild(toast); } toast.className = `toast${isError ? ' error' : ''}`; toast.textContent = message; show(toast); clearTimeout(window.wordflowToastTimer); window.wordflowToastTimer = setTimeout(() => hide(toast), 3200); }

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; show($('installBtn')); });
$('installBtn').addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; hide($('installBtn')); });
// Ignore the temporary hash used by a returning magic link until the cloud
// session has completed its first safe download/upload reconciliation.
window.addEventListener('hashchange', () => { if (cloudReadyForUserId) navigate(location.hash.slice(1)); });

async function boot() {
  try {
    db = await openDatabase();
    if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
    await loadSettings(); await upgradeStoredItems(); $('masterPrompt').textContent = MASTER_PROMPT;
    createManualExampleFields(); createReminderTimeFields(); wireEvents();
    const cloudReady = await initializeCloudSync();
    if (cloudReady) { scheduleReminders(); navigate(location.hash.slice(1) || 'today'); }
  } catch (error) { console.error(error); document.querySelector('.app-shell').textContent = `WordFlow could not start: ${error.message}`; }
}

boot();
