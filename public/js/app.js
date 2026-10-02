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
// These caps keep imports and restores responsive on a phone and prevent a
// malformed local/cloud payload from exhausting browser storage or memory.
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_STORED_ITEMS = 5000;
const MAX_ITEM_BYTES = 12 * 1024;
const MAX_TERM_LENGTH = 120;
const MAX_TYPE_LENGTH = 80;
const MAX_MEANING_LENGTH = 1200;
const MAX_EXPLANATION_LENGTH = 2400;
const MAX_ORIGIN_LENGTH = 2400;
const MAX_PRONUNCIATION_LENGTH = 160;
const MAX_CATEGORY_LENGTH = 120;
const MAX_DIFFICULTY_LENGTH = 80;
const MAX_EXAMPLE_LENGTH = 1200;
const MAX_SYNONYM_LENGTH = 120;
const MAX_SYNONYMS = 20;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
    "pronunciation": "/əˈlaɪn ɒn/", "explanation": "A fuller explanation of how it is used.",
    "origin": "A short, accurate word-origin note.", "synonyms": ["alternative 1", "alternative 2"],
    "category": "IT meetings", "difficulty": "Intermediate",
    "examples": ["Example 1.", "Example 2.", "Example 3.", "Example 4.", "Example 5."]
  }]
}

Rules: exactly five natural examples per item; no markdown fences; no text outside JSON.`;

let db;
let settings;
let currentTodayItem = null;
let currentImport = null;
let libraryFilter = 'queued';
let openTopicName = null;
let reminderTimers = [];
let deferredInstallPrompt = null;
let supabaseClient = null;
let supabaseSession = null;
let cloudReadyForUserId = null;
let cloudActivationForUserId = null;
let cloudSyncTimer = null;
let cloudRealtimeChannel = null;
let cloudRealtimeUserId = null;
let applyingCloudState = false;
let serviceWorkerRegistration = null;
let refreshingForUpdate = false;
let hasPendingCloudChanges = false;
let cloudStatusIsError = false;
let cloudChangeRevision = 0;
let cloudSyncBaselineChangedAt = null;
let cloudReconciliationComplete = false;
let bootstrappingLocalState = true;
let hasUserChangesBeforeCloudReconcile = false;

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

function isPlainRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function textByteLength(value) { return new TextEncoder().encode(String(value)).byteLength; }
function serializedByteLength(value) { return textByteLength(JSON.stringify(value)); }

function transactionComplete(databaseTransaction) {
  return new Promise((resolve, reject) => {
    databaseTransaction.oncomplete = () => resolve();
    databaseTransaction.onerror = () => reject(databaseTransaction.error || new Error('Local storage could not be updated.'));
    databaseTransaction.onabort = () => reject(databaseTransaction.error || new Error('Local storage update was cancelled.'));
  });
}

// A restore/download must replace items and settings as one IndexedDB
// transaction. If validation or a write fails, the previous local library
// remains intact instead of being partly cleared.
async function replaceStoredState(items, nextSettings) {
  const databaseTransaction = db.transaction([ITEM_STORE, SETTINGS_STORE], 'readwrite');
  const done = transactionComplete(databaseTransaction);
  try {
    const itemsStore = databaseTransaction.objectStore(ITEM_STORE);
    const settingsStore = databaseTransaction.objectStore(SETTINGS_STORE);
    itemsStore.clear();
    items.forEach((item) => itemsStore.put(item));
    settingsStore.put({ key: 'app', value: nextSettings });
  } catch (error) {
    try { databaseTransaction.abort(); } catch { /* The transaction may already be closed. */ }
    await done.catch(() => {});
    throw error;
  }
  await done;
}

function defaultSettings() { return { reminderTimes: DEFAULT_REMINDER_TIMES, todayDate: null, todayItemId: null, selectedTopic: '', dailyGoal: 3, dailyGoalDate: null, dailyGoalCompletedIds: [], darkMode: false, remindersEnabled: false, pushEnabled: false, lastChangedAt: null }; }

function normaliseSettings(value, source = 'Settings') {
  if (!isPlainRecord(value)) throw new Error(`${source} has an invalid settings section.`);
  const defaults = defaultSettings();
  const reminderTimes = value.reminderTimes === undefined ? defaults.reminderTimes : value.reminderTimes;
  if (!Array.isArray(reminderTimes) || reminderTimes.length !== 5 || reminderTimes.some((time) => typeof time !== 'string' || !TIME_PATTERN.test(time)) || new Set(reminderTimes).size !== 5) {
    throw new Error(`${source} has invalid reminder times.`);
  }
  const optionalDate = (date, name) => {
    if (date === undefined || date === null || date === '') return null;
    if (typeof date !== 'string' || !DATE_KEY_PATTERN.test(date)) throw new Error(`${source} has an invalid ${name}.`);
    return date;
  };
  const optionalIdentifier = (identifier, name) => {
    if (identifier === undefined || identifier === null || identifier === '') return null;
    if (typeof identifier !== 'string' || identifier.length > 200) throw new Error(`${source} has an invalid ${name}.`);
    return identifier;
  };
  const optionalBoolean = (boolean, name, fallback) => {
    if (boolean === undefined) return fallback;
    if (typeof boolean !== 'boolean') throw new Error(`${source} has an invalid ${name}.`);
    return boolean;
  };
  const dailyGoal = value.dailyGoal === undefined ? defaults.dailyGoal : value.dailyGoal;
  if (!Number.isInteger(dailyGoal) || dailyGoal < 1 || dailyGoal > 20) throw new Error(`${source} has an invalid daily goal.`);
  const dailyGoalCompletedIds = value.dailyGoalCompletedIds === undefined ? [] : value.dailyGoalCompletedIds;
  if (!Array.isArray(dailyGoalCompletedIds) || dailyGoalCompletedIds.length > 100 || dailyGoalCompletedIds.some((id) => typeof id !== 'string' || !id || id.length > 200)) {
    throw new Error(`${source} has invalid daily-goal progress.`);
  }
  const selectedTopic = value.selectedTopic === undefined ? '' : value.selectedTopic;
  if (typeof selectedTopic !== 'string' || selectedTopic.length > MAX_CATEGORY_LENGTH) throw new Error(`${source} has an invalid selected topic.`);
  const lastChangedAt = value.lastChangedAt === undefined || value.lastChangedAt === null || value.lastChangedAt === '' ? null : value.lastChangedAt;
  if (lastChangedAt !== null && (typeof lastChangedAt !== 'string' || lastChangedAt.length > 64 || !Number.isFinite(Date.parse(lastChangedAt)))) {
    throw new Error(`${source} has an invalid modification time.`);
  }
  return {
    ...defaults,
    reminderTimes: [...reminderTimes].sort(),
    todayDate: optionalDate(value.todayDate, 'today date'),
    todayItemId: optionalIdentifier(value.todayItemId, 'today word'),
    selectedTopic: selectedTopic.trim(),
    dailyGoal,
    dailyGoalDate: optionalDate(value.dailyGoalDate, 'daily-goal date'),
    dailyGoalCompletedIds: [...new Set(dailyGoalCompletedIds)],
    darkMode: optionalBoolean(value.darkMode, 'theme preference', false),
    remindersEnabled: optionalBoolean(value.remindersEnabled, 'reminder preference', false),
    pushEnabled: optionalBoolean(value.pushEnabled, 'push preference', false),
    lastChangedAt
  };
}

async function loadSettings() {
  const saved = await getSetting('app');
  const syncState = await getSetting('cloud-sync');
  try { settings = normaliseSettings(saved || {}); } catch (error) { console.warn('WordFlow settings were reset after validation failed:', error); settings = defaultSettings(); }
  hasPendingCloudChanges = Boolean(syncState?.dirty);
  cloudChangeRevision = Number.isInteger(syncState?.revision) ? syncState.revision : 0;
  // A first launch needs a timestamp; existing local/cloud state must keep its
  // original timestamp so the newer copy can win during reconciliation.
  if (!saved) await persistSettings();
}
async function persistSettings() { settings.lastChangedAt = new Date().toISOString(); markCloudChangesPending(); await saveSetting('app', settings); queueCloudSync(); }

function recordLocalChange() {
  // During a download from Supabase, do not immediately upload that same state.
  if (applyingCloudState || !settings) return;
  settings.lastChangedAt = new Date().toISOString();
  markCloudChangesPending();
  void saveSetting('app', settings);
  queueCloudSync();
}

function markCloudChangesPending() {
  if (applyingCloudState) return;
  cloudChangeRevision += 1;
  hasPendingCloudChanges = true;
  // Keep this device-only bit outside the synced app settings. It survives an
  // offline restart without falsely telling another device it has pending work.
  void saveSetting('cloud-sync', { dirty: true, revision: cloudChangeRevision });
  if (!bootstrappingLocalState && !cloudReconciliationComplete) hasUserChangesBeforeCloudReconcile = true;
  updateSyncControl();
}

function clearPendingCloudChanges(revision = null) {
  // An older upload must never clear the marker for an edit made while that
  // upload was in flight.
  if (revision !== null && revision !== cloudChangeRevision) return;
  hasPendingCloudChanges = false;
  void saveSetting('cloud-sync', { dirty: false, revision: cloudChangeRevision });
  updateSyncControl();
}

async function upgradeStoredItems() {
  // Existing imports keep working when new optional presentation fields appear.
  for (const item of await getAllItems()) {
    if (item.isFavorite === undefined || item.reviewStage === undefined || item.reviewDueDate === undefined || item.origin === undefined || item.synonyms === undefined || item.pronunciation === undefined || item.category === undefined) {
      await saveItem({ isFavorite: false, reviewStage: null, reviewDueDate: null, origin: '', synonyms: [], pronunciation: '', category: '', ...item });
    }
  }
}

function setCloudStatus(message, isError = false) {
  const status = $('cloudStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error-text', isError);
  cloudStatusIsError = isError;
  updateSyncControl();
}

function updateSyncControl() {
  const button = $('syncNowBtn');
  if (!button) return;
  const signedIn = Boolean(supabaseSession);
  const connected = Boolean(cloudReadyForUserId);
  const changesWaitingOffline = hasPendingCloudChanges && (!navigator.onLine || !connected);
  button.classList.toggle('is-connected', connected);
  button.classList.toggle('is-offline', changesWaitingOffline);
  button.classList.toggle('is-error', cloudStatusIsError && !changesWaitingOffline);
  button.setAttribute('aria-label', changesWaitingOffline ? 'Offline changes waiting to sync' : 'Cloud sync and updates');
  $('syncMenuStatus').textContent = changesWaitingOffline ? (signedIn ? 'Offline — changes will sync when connected.' : 'Changes are saved here. Sign in to sync them.') : connected ? 'Cloud sync active' : signedIn ? $('cloudStatus').textContent : 'Not signed in to cloud sync';
  $('syncMenuBtn').classList.toggle('hidden', !signedIn);
  $('signInBtn').classList.toggle('hidden', signedIn);
}

// This is an optional sign-in sheet. The local library stays visible behind it.
function showAuthGate(message = '', isError = false) {
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

function applyTheme() {
  const isDark = Boolean(settings?.darkMode);
  document.documentElement.dataset.theme = isDark ? 'dark' : '';
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#181816' : '#f7f4ec');
  const toggle = $('darkModeToggle');
  if (toggle) toggle.checked = isDark;
}

async function toggleDarkMode(event) {
  settings.darkMode = event.target.checked;
  applyTheme();
  await persistSettings();
  showToast(settings.darkMode ? 'Dark mode enabled.' : 'Light mode enabled.');
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
    return false;
  }
  if (!window.supabase) {
    setCloudStatus('Cloud sync library could not load. Working offline.', true);
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
    // page refresh. An expired session simply leaves cloud sync optional.
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      supabaseSession = session;
      if (!session) {
        cloudReadyForUserId = null;
        void stopCloudRealtime();
        setCloudStatus('Not signed in. Your library stays on this device.');
        return;
      }
      void activateCloudSession();
    });

    if (!supabaseSession) {
      setCloudStatus('Not signed in. Tap sync to connect your library.');
      return false;
    }
    return activateCloudSession();
  } catch (error) {
    console.warn('WordFlow cloud sync unavailable:', error);
    setCloudStatus('Cloud setup needs attention. WordFlow is still working locally.', true);
    return false;
  }
}

async function activateCloudSession() {
  const userId = supabaseSession?.user?.id;
  if (!userId || cloudReadyForUserId === userId || cloudActivationForUserId === userId) return Boolean(cloudReadyForUserId === userId);
  cloudActivationForUserId = userId;

  try {
    setCloudStatus('Syncing your private library…');
    const synced = await reconcileCloudState();
    if (!synced) throw new Error('Cloud state could not be saved.');
    // Ignore a slow response if the user changed accounts during that request.
    if (supabaseSession?.user?.id !== userId) return false;
    cloudReadyForUserId = userId;
    if (settings.pushEnabled) void syncPushSubscription();
    setCloudStatus('Live sync active');
    void startCloudRealtime();
  } catch (error) {
    // A valid login must not lock a person out of their offline data if the
    // network or Supabase is temporarily unavailable.
    console.warn('WordFlow cloud reconciliation failed:', error);
    setCloudStatus('Cloud sync needs attention. Your local copy is still available.', true);
  } finally {
    if (cloudActivationForUserId === userId) cloudActivationForUserId = null;
  }

  scheduleReminders();
  navigate(requestedRoute());
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
  if (!supabaseClient || !supabaseSession || applyingCloudState) return false;
  const uploadRevision = cloudChangeRevision;
  const payload = { items: await getAllItems(), settings };
  const { error } = await supabaseClient.from('wordflow_device_state').upsert({ user_id: supabaseSession.user.id, payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) { console.warn('WordFlow cloud upload failed:', error); setCloudStatus('Cloud sync could not save. Working locally.', true); return false; }
  clearPendingCloudChanges(uploadRevision);
  setCloudStatus(`Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  return true;
}

async function reconcileCloudState() {
  const { data, error } = await supabaseClient.from('wordflow_device_state').select('payload, updated_at').eq('user_id', supabaseSession.user.id).maybeSingle();
  if (error) throw error;
  const remoteChangedAt = Date.parse(data?.payload?.settings?.lastChangedAt || data?.updated_at || 0);
  // The first paint intentionally avoids blocking on Supabase. Ignore its
  // bookkeeping writes when deciding whether a newer cloud snapshot wins.
  const localTimestamp = !cloudReconciliationComplete && !hasUserChangesBeforeCloudReconcile
    ? cloudSyncBaselineChangedAt
    : settings.lastChangedAt;
  const localChangedAt = Date.parse(localTimestamp || 0);
  const localItems = await getAllItems();
  // A fresh phone creates a local settings timestamp before it receives its
  // session. If it has no vocabulary yet, prefer the existing cloud library.
  if (Array.isArray(data?.payload?.items) && (localItems.length === 0 || remoteChangedAt > localChangedAt)) {
    await applyCloudState(data.payload);
    return true;
  }
  return uploadCloudState();
}

// Realtime updates only exist while WordFlow is open. They supplement the
// normal start-up/manual sync path and avoid wasteful two-second polling.
async function startCloudRealtime() {
  const userId = supabaseSession?.user?.id;
  if (!supabaseClient || !userId || cloudRealtimeUserId === userId) return;
  await stopCloudRealtime();
  if (supabaseSession?.user?.id !== userId) return;

  cloudRealtimeUserId = userId;
  cloudRealtimeChannel = supabaseClient
    .channel(`wordflow-library-${userId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'wordflow_device_state', filter: `user_id=eq.${userId}`
    }, (change) => { void applyRealtimeCloudChange(change.new); })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setCloudStatus('Live sync active');
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setCloudStatus('Live sync disconnected. Use Sync now while it reconnects.', true);
    });
}

async function stopCloudRealtime() {
  const channel = cloudRealtimeChannel;
  cloudRealtimeChannel = null;
  cloudRealtimeUserId = null;
  if (channel && supabaseClient) await supabaseClient.removeChannel(channel);
}

async function applyRealtimeCloudChange(remoteRecord) {
  if (applyingCloudState || !remoteRecord?.payload || remoteRecord.user_id !== supabaseSession?.user?.id) return;
  const remoteChangedAt = Date.parse(remoteRecord.payload.settings?.lastChangedAt || remoteRecord.updated_at || 0);
  const localChangedAt = Date.parse(settings.lastChangedAt || 0);
  // Ignore our own echoed write. A newer write from another open device wins.
  if (!Array.isArray(remoteRecord.payload.items) || remoteChangedAt <= localChangedAt) return;
  try {
    await applyCloudState(remoteRecord.payload);
    setCloudStatus(`Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (error) {
    console.warn('WordFlow live update could not be applied:', error);
    setCloudStatus('A live update could not be applied. Use Sync now to retry.', true);
  }
}

async function syncNow() {
  if (!supabaseClient || !supabaseSession) return showAuthGate('Enter your email to sync this library across devices.');
  const button = $('syncNowBtn');
  button.disabled = true;
  button.classList.add('is-syncing');
  button.setAttribute('aria-busy', 'true');
  setCloudStatus('Syncing now…');
  try {
    const synced = await reconcileCloudState();
    if (!synced) return;
    if (settings.pushEnabled) await syncPushSubscription();
    setCloudStatus(`Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    showToast('Library is synced.');
  } catch (error) {
    console.warn('WordFlow manual sync failed:', error);
    setCloudStatus('Sync now could not complete. Your local copy is safe.', true);
    showToast('Sync could not complete. Please try again.', true);
  } finally {
    button.disabled = false;
    button.classList.remove('is-syncing');
    button.removeAttribute('aria-busy');
  }
}

async function applyCloudState(payload) {
  const restoredState = validateStoredState(payload, 'Cloud backup');
  applyingCloudState = true;
  try {
    await replaceStoredState(restoredState.items, restoredState.settings);
    settings = restoredState.settings;
    clearPendingCloudChanges();
    applyTheme();
    createReminderTimeFields();
    scheduleReminders();
    if (settings.pushEnabled) void syncPushSubscription();
    await Promise.all([loadToday(), renderTopics(), renderReviews(), renderLibrary(), updateNotificationStatus()]);
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
    const input = document.createElement('input');
    input.type = 'time'; input.value = time; input.required = true; input.dataset.reminderTime = String(index); input.setAttribute('aria-label', `Reminder ${index + 1}`);
    label.appendChild(input); container.appendChild(label);
  });
}

function wireEvents() {
  $('magicLinkForm').addEventListener('submit', sendMagicLink);
  $('authCloseBtn').addEventListener('click', () => hide($('authGate')));
  $('syncNowBtn').addEventListener('click', toggleSyncMenu);
  $('syncMenuBtn').addEventListener('click', () => { hideSyncMenu(); void syncNow(); });
  $('signInBtn').addEventListener('click', () => { hideSyncMenu(); showAuthGate('Enter your email and we’ll send a secure sign-in link.'); });
  $('checkUpdateBtn').addEventListener('click', () => void checkForUpdate());
  $('refreshAppBtn').addEventListener('click', applyWaitingUpdate);
  $('darkModeToggle').addEventListener('change', toggleDarkMode);
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $('knowBtn').addEventListener('click', () => updateTodayStatus('learned'));
  $('reviewBtn').addEventListener('click', () => updateTodayStatus('review'));
  $('nextWordBtn').addEventListener('click', advanceToNextWord);
  $('speakBtn').addEventListener('click', pronounceTodayWord);
  // Do not pass the click event as the word. Queue rows explicitly pass an
  // item, while the Today button should always open currentTodayItem.
  $('detailsBtn').addEventListener('click', () => openDetails());
  $('detailsClose').addEventListener('click', closeDetails);
  $('detailsCloseButton').addEventListener('click', closeDetails);
  $('favoriteBtn').addEventListener('click', () => currentTodayItem && toggleFavorite(currentTodayItem));
  $('notificationBtn').addEventListener('click', enableNotifications);
  $('jsonFileInput').addEventListener('change', readFileImport);
  $('previewPasteBtn').addEventListener('click', previewPastedImport);
  $('importBtn').addEventListener('click', importPack);
  $('changeImportBtn').addEventListener('click', resetImportPreview);
  $('copyPromptBtn').addEventListener('click', copyMasterPrompt);
  $('librarySearch').addEventListener('input', renderLibrary);
  $('topicSelect').addEventListener('change', changeTodayTopic);
  $('backToTopicsBtn').addEventListener('click', showTopicsOverview);
  $('settingsForm').addEventListener('submit', saveReminderTimes);
  $('exportBtn').addEventListener('click', exportBackup);
  $('restoreFileInput').addEventListener('change', restoreBackup);
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach((button) => button.classList.remove('active'));
    chip.classList.add('active'); libraryFilter = chip.dataset.filter; renderLibrary();
  }));
}

function toggleSyncMenu() {
  const menu = $('syncMenu');
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  $('syncNowBtn').setAttribute('aria-expanded', String(willOpen));
}

function hideSyncMenu() { hide($('syncMenu')); $('syncNowBtn').setAttribute('aria-expanded', 'false'); }

function announceUpdate(registration = serviceWorkerRegistration) {
  if (!registration?.waiting) return false;
  show($('refreshAppBtn'));
  $('syncMenuStatus').textContent = 'A newer WordFlow version is ready.';
  return true;
}

async function checkForUpdate() {
  const button = $('checkUpdateBtn');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    if (!serviceWorkerRegistration) serviceWorkerRegistration = await navigator.serviceWorker?.getRegistration();
    await serviceWorkerRegistration?.update();
    if (!announceUpdate()) $('syncMenuStatus').textContent = 'You already have the latest version.';
  } catch {
    $('syncMenuStatus').textContent = 'Could not check for an update right now.';
  } finally {
    button.disabled = false;
    button.textContent = 'Check for update';
  }
}

function applyWaitingUpdate() {
  if (!serviceWorkerRegistration?.waiting) return window.location.reload();
  refreshingForUpdate = true;
  serviceWorkerRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
    announceUpdate();
    serviceWorkerRegistration.addEventListener('updatefound', () => {
      const worker = serviceWorkerRegistration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') announceUpdate(); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshingForUpdate) window.location.reload(); });
  } catch (error) {
    // Service-worker support improves offline/PWA behavior but must never
    // prevent the IndexedDB app from opening in a restricted browser mode.
    console.warn('WordFlow service worker could not register:', error);
  }
}

const APP_ROUTES = new Set(['today', 'topics', 'library', 'import', 'settings']);

function requestedRoute() {
  const route = location.hash.slice(1);
  // Keep old Queue links functional; navigate() translates this to Library's
  // Queue filter after startup rather than silently sending people to Today.
  return route === 'queue' || APP_ROUTES.has(route) ? route : 'today';
}

function isSupabaseCallback() {
  const callbackData = `${location.search}&${location.hash}`;
  return /(?:access_token|refresh_token|code|error_description)=/.test(callbackData);
}

function navigate(section) {
  // Old bookmarks to the retired Queue page stay useful by opening Library's
  // Queue filter instead of leading to a blank route.
  if (section === 'queue') {
    libraryFilter = 'queued';
    section = 'library';
  }
  const target = APP_ROUTES.has(section) ? section : 'today';
  document.querySelectorAll('[data-section]').forEach((element) => element.classList.toggle('hidden', element.dataset.section !== target));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.nav === target));
  history.replaceState(null, '', `#${target}`);
  if (target === 'today') loadToday();
  if (target === 'topics') renderTopics();
  if (target === 'library') renderLibrary();
  if (target === 'settings') createReminderTimeFields();
}

function topicNameFor(item) { return item.category?.trim() || 'Uncategorized'; }
function inSelectedTopic(item) { return !settings.selectedTopic || topicNameFor(item) === settings.selectedTopic; }
function topicProgress(items) { return items.filter((item) => item.status !== 'queued').length; }

async function ensureDailyGoalToday() {
  if (settings.dailyGoalDate === todayKey()) return;
  settings.dailyGoalDate = todayKey();
  settings.dailyGoalCompletedIds = [];
  await persistSettings();
}

function renderDailyGoal() {
  const goal = settings.dailyGoal;
  const completedIds = settings.dailyGoalDate === todayKey() ? settings.dailyGoalCompletedIds : [];
  const completed = Math.min(goal, completedIds.length);
  $('dailyGoalText').textContent = `${completed} of ${goal} words`;
  $('dailyGoal').setAttribute('aria-label', `Daily goal: ${completed} of ${goal} words`);
  $('dailyGoalDots').replaceChildren(...Array.from({ length: goal }, (_, index) => {
    const dot = document.createElement('i');
    if (index < completed) dot.classList.add('complete');
    return dot;
  }));
}

async function countTowardDailyGoal(itemId) {
  await ensureDailyGoalToday();
  if (!settings.dailyGoalCompletedIds.includes(itemId)) {
    settings.dailyGoalCompletedIds.push(itemId);
    await persistSettings();
  }
  renderDailyGoal();
}

async function renderTopicPicker(items, allowMutations = true) {
  if (!items) items = await getAllItems();
  const select = $('topicSelect');
  const topics = [...new Set(items.map(topicNameFor))].sort((a, b) => a.localeCompare(b));
  if (settings.selectedTopic && !topics.includes(settings.selectedTopic)) {
    settings.selectedTopic = '';
    if (allowMutations) await persistSettings();
  }
  select.replaceChildren();
  const allOption = document.createElement('option'); allOption.value = ''; allOption.textContent = 'All topics'; select.append(allOption);
  topics.forEach((topic) => { const option = document.createElement('option'); option.value = topic; option.textContent = topic; select.append(option); });
  select.value = settings.selectedTopic;
}

async function changeTodayTopic(event) {
  const selectedTopic = event.target.value;
  if (selectedTopic === settings.selectedTopic) return;
  // Returning an untouched active item to the queue lets a topic change pick
  // a fresh word without incorrectly scheduling that item for review.
  const previous = settings.todayItemId ? await getItem(settings.todayItemId) : null;
  if (previous?.status === 'active') await saveItem({ ...previous, status: 'queued', startedOn: null });
  settings.selectedTopic = selectedTopic;
  settings.todayDate = null;
  settings.todayItemId = null;
  await persistSettings();
  await Promise.all([loadToday(), renderTopics(), renderLibrary()]);
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
    const queued = (await getAllItems()).filter((item) => item.status === 'queued' && inSelectedTopic(item)).sort((a, b) => a.queuePosition - b.queuePosition)[0];
    settings.todayDate = date; settings.todayItemId = queued?.id || null;
    if (queued) await saveItem({ ...queued, status: 'active', startedOn: date });
    await persistSettings();
  }
  return settings.todayItemId ? getItem(settings.todayItemId) : null;
}

async function loadToday({ allowMutations = true } = {}) {
  if (allowMutations) await ensureDailyGoalToday();
  renderDailyGoal();
  const allItems = await getAllItems();
  await renderTopicPicker(allItems, allowMutations);
  currentTodayItem = allowMutations
    ? await ensureTodayItem()
    : (settings.todayItemId ? await getItem(settings.todayItemId) : allItems.find((item) => item.status === 'active') || allItems.find((item) => item.status === 'queued') || null);
  if (!currentTodayItem) { hide($('todayCard')); show($('todayEmpty')); await updateNotificationStatus(); return; }
  hide($('todayEmpty')); show($('todayCard'));
  $('todayType').textContent = currentTodayItem.type;
  $('todayTerm').textContent = currentTodayItem.term;
  $('todayPronunciation').textContent = currentTodayItem.pronunciation || 'Pronounce';
  $('todayMeaning').textContent = currentTodayItem.meaning;
  // The import format calls this an explanation; on the Today screen it is a
  // short practical cue for when the word fits naturally in conversation.
  $('todayExplanation').textContent = currentTodayItem.explanation || '';
  const topicItems = allItems.filter(inSelectedTopic);
  $('todayProgress').style.width = `${Math.min(100, Math.max(8, (topicItems.filter((item) => item.status === 'learned').length / Math.max(1, topicItems.length)) * 100))}%`;
  $('knowBtn').classList.toggle('is-selected', currentTodayItem.status === 'learned' || currentTodayItem.reviewStage !== null);
  $('reviewBtn').classList.toggle('is-selected', currentTodayItem.status === 'review' && currentTodayItem.reviewStage === null);
  $('favoriteBtn').classList.toggle('is-selected', currentTodayItem.isFavorite);
  await updateNotificationStatus();
}

function openDetails(item) {
  // A defensive fallback also protects this view if a browser event is ever
  // passed here accidentally: only an actual vocabulary item is valid data.
  const selectedItem = item?.term ? item : currentTodayItem;
  if (!selectedItem) return;
  // The Today action already presents the definition on its own screen. List
  // cards hide it for symmetry, then reveal it only in their detail view.
  const openedFromCollection = Boolean(item?.term);
  $('detailContext').classList.toggle('hidden', !openedFromCollection);
  if (openedFromCollection) {
    $('detailTerm').textContent = selectedItem.term;
    $('detailMeaning').textContent = selectedItem.meaning;
  }
  // Older imported packs did not include every optional detail. Keep the
  // sheet useful (and avoid a blank panel) when opening one of those words.
  const examples = Array.isArray(selectedItem.examples) && selectedItem.examples.length
    ? selectedItem.examples : ['No example sentences have been added yet.'];
  $('detailExamples').replaceChildren(...examples.map((example) => {
    const row = document.createElement('li'); row.textContent = example; return row;
  }));
  $('detailUsage').textContent = selectedItem.explanation || 'No usage note has been added yet.';
  $('detailOrigin').textContent = selectedItem.origin || 'No origin note has been added for this word yet.';
  const synonyms = selectedItem.synonyms?.length ? selectedItem.synonyms : ['No synonyms added'];
  $('detailSynonyms').replaceChildren(...synonyms.map((synonym) => {
    const chip = document.createElement('span'); chip.textContent = synonym; return chip;
  }));
  show($('detailsSheet'));
  // A previous tall word may have left the sheet scrolled down. Always open
  // at its first section so examples and usage notes are immediately visible.
  document.querySelector('.details-panel').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeDetails() {
  hide($('detailsSheet'));
  document.body.style.overflow = '';
}

async function updateTodayStatus(status) {
  if (!currentTodayItem) return;
  let updated = { ...currentTodayItem, status };
  if (status === 'learned') updated = scheduleFirstReview(updated);
  // "Review later" keeps an item visible in the review tab today without
  // changing the spaced-repetition stage that it may receive later.
  if (status === 'review') updated = { ...updated, reviewDueDate: todayKey(), reviewStage: null };
  await saveItem(updated); currentTodayItem = updated;
  await countTowardDailyGoal(updated.id);
  showToast(status === 'learned' ? 'Added to your 1, 3, 7, 21, 60-day review plan.' : 'Added to your review list.');
  await Promise.all([loadToday(), renderTopics(), renderReviews(), renderLibrary()]);
}

async function advanceToNextWord() {
  if (!currentTodayItem) return;
  // Skipping an untouched daily word places it in today's review queue instead
  // of silently losing it, then makes the next queued word available now.
  if (currentTodayItem.status === 'active') {
    await saveItem({ ...currentTodayItem, status: 'review', reviewDueDate: todayKey(), reviewStage: null });
  }
  settings.todayItemId = null;
  await persistSettings();
  await Promise.all([loadToday(), renderTopics(), renderLibrary(), renderReviews()]);
  showToast(currentTodayItem ? 'Next word is ready.' : 'Your learning queue is empty.');
}

function scheduleFirstReview(item) {
  return { ...item, status: 'review', learnedAt: new Date().toISOString(), reviewStage: 0, reviewDueDate: addDaysKey(REVIEW_INTERVALS_DAYS[0]) };
}

function buildItem(raw, queuePosition) {
  return { id: uid(), term: raw.term.trim(), normalizedTerm: normalizeTerm(raw.term), type: raw.type.trim(), meaning: raw.meaning.trim(), pronunciation: (raw.pronunciation || '').trim(), explanation: (raw.explanation || '').trim(), origin: (raw.origin || '').trim(), synonyms: (raw.synonyms || []).map((synonym) => synonym.trim()), category: (raw.category || '').trim(), difficulty: (raw.difficulty || '').trim(), examples: raw.examples.map((example) => example.trim()), status: 'queued', queuePosition, createdAt: new Date().toISOString(), startedOn: null, learnedAt: null, isFavorite: false, reviewStage: null, reviewDueDate: null };
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

function validateText(value, label, maximumLength, required = false) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  if (value.length > maximumLength) throw new Error(`${label} is too long.`);
  if (required && !value.trim()) throw new Error(`${label} cannot be empty.`);
}

function validateWordFields(item, name, { allowEmptyOptional = false } = {}) {
  if (!isPlainRecord(item)) throw new Error(`${name} must be an object.`);
  [['term', MAX_TERM_LENGTH], ['type', MAX_TYPE_LENGTH], ['meaning', MAX_MEANING_LENGTH]].forEach(([field, maximumLength]) => {
    validateText(item[field], `${name} ${field}`, maximumLength, true);
  });
  if (!Array.isArray(item.examples) || item.examples.length !== 5) throw new Error(`${name} needs exactly five example sentences.`);
  item.examples.forEach((example, index) => validateText(example, `${name} example ${index + 1}`, MAX_EXAMPLE_LENGTH, true));
  if (item.origin !== undefined) validateText(item.origin, `${name} origin`, MAX_ORIGIN_LENGTH, !allowEmptyOptional);
  if (item.pronunciation !== undefined) validateText(item.pronunciation, `${name} pronunciation`, MAX_PRONUNCIATION_LENGTH);
  if (item.explanation !== undefined) validateText(item.explanation, `${name} usage note`, MAX_EXPLANATION_LENGTH);
  if (item.category !== undefined) validateText(item.category, `${name} category`, MAX_CATEGORY_LENGTH);
  if (item.difficulty !== undefined) validateText(item.difficulty, `${name} difficulty`, MAX_DIFFICULTY_LENGTH);
  if (item.synonyms !== undefined) {
    if (!Array.isArray(item.synonyms) || item.synonyms.length > MAX_SYNONYMS || (!allowEmptyOptional && !item.synonyms.length)) throw new Error(`${name} has invalid synonyms.`);
    item.synonyms.forEach((synonym, index) => validateText(synonym, `${name} synonym ${index + 1}`, MAX_SYNONYM_LENGTH, !allowEmptyOptional));
  }
  if (serializedByteLength(item) > MAX_ITEM_BYTES) throw new Error(`${name} is too large.`);
}

function validateItem(item, name = 'Item') { validateWordFields(item, name); }

function normaliseStoredItem(item, name) {
  validateWordFields(item, name, { allowEmptyOptional: true });
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) throw new Error(`${name} has an invalid ID.`);
  if (!VALID_STATUSES.has(item.status)) throw new Error(`${name} has an invalid status.`);
  if (!Number.isFinite(item.queuePosition)) throw new Error(`${name} has an invalid queue position.`);
  const optionalTimestamp = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error(`${name} has an invalid ${field}.`);
    return value;
  };
  const optionalDate = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) throw new Error(`${name} has an invalid ${field}.`);
    return value;
  };
  const reviewStage = item.reviewStage === undefined || item.reviewStage === null ? null : item.reviewStage;
  if (reviewStage !== null && (!Number.isInteger(reviewStage) || reviewStage < 0 || reviewStage > REVIEW_INTERVALS_DAYS.length)) throw new Error(`${name} has an invalid review stage.`);
  if (item.isFavorite !== undefined && typeof item.isFavorite !== 'boolean') throw new Error(`${name} has an invalid saved status.`);
  return {
    ...item,
    id: item.id.trim(),
    term: item.term.trim(),
    normalizedTerm: normalizeTerm(item.term),
    type: item.type.trim(),
    meaning: item.meaning.trim(),
    pronunciation: (item.pronunciation || '').trim(),
    explanation: (item.explanation || '').trim(),
    origin: (item.origin || '').trim(),
    synonyms: (item.synonyms || []).map((synonym) => synonym.trim()),
    category: (item.category || '').trim(),
    difficulty: (item.difficulty || '').trim(),
    examples: item.examples.map((example) => example.trim()),
    queuePosition: item.queuePosition,
    createdAt: optionalTimestamp(item.createdAt, 'creation time') || new Date(0).toISOString(),
    startedOn: optionalDate(item.startedOn, 'start date'),
    learnedAt: optionalTimestamp(item.learnedAt, 'learned time'),
    isFavorite: Boolean(item.isFavorite),
    reviewStage,
    reviewDueDate: optionalDate(item.reviewDueDate, 'review date')
  };
}

function validateStoredState(payload, source = 'Backup') {
  if (!isPlainRecord(payload) || !Array.isArray(payload.items) || !payload.settings) throw new Error(`${source} has an invalid format.`);
  if (payload.items.length > MAX_STORED_ITEMS) throw new Error(`${source} contains too many words.`);
  if (serializedByteLength(payload) > MAX_BACKUP_BYTES) throw new Error(`${source} is too large.`);
  const itemIds = new Set();
  const terms = new Set();
  const items = payload.items.map((item, index) => {
    const normalised = normaliseStoredItem(item, `${source} item ${index + 1}`);
    if (itemIds.has(normalised.id) || terms.has(normalised.normalizedTerm)) throw new Error(`${source} contains duplicate words.`);
    itemIds.add(normalised.id);
    terms.add(normalised.normalizedTerm);
    return normalised;
  });
  return { items, settings: normaliseSettings(payload.settings, source) };
}

function validatePack(payload) {
  if (!isPlainRecord(payload) || payload.schema_version !== 1 || !isPlainRecord(payload.pack) || !Array.isArray(payload.items) || !payload.items.length) throw new Error('This is not a valid WordFlow pack.');
  if (serializedByteLength(payload) > MAX_IMPORT_BYTES) throw new Error('This pack is too large.');
  validateText(payload.pack.name, 'Pack name', 160, true);
  if (payload.pack.description !== undefined) validateText(payload.pack.description, 'Pack description', 600);
  if (payload.pack.topic !== undefined) validateText(payload.pack.topic, 'Pack topic', MAX_CATEGORY_LENGTH);
  if (payload.pack.difficulty !== undefined) validateText(payload.pack.difficulty, 'Pack difficulty', MAX_DIFFICULTY_LENGTH);
  if (payload.items.length > 200) throw new Error('A pack can contain at most 200 items.');
  const terms = new Set();
  payload.items.forEach((item, index) => {
    validateItem(item, `Item ${index + 1}`);
    const term = normalizeTerm(item.term);
    if (terms.has(term)) throw new Error('A pack cannot contain the same word twice.');
    terms.add(term);
  });
  return payload;
}

async function readFileImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is larger than the 2 MB import limit.');
    previewImport(JSON.parse(await file.text()), file.name);
  } catch (error) { showToast(`Could not read that JSON: ${error.message}`, true); }
}

function previewPastedImport() {
  try {
    const pasted = $('jsonPaste').value;
    if (textByteLength(pasted) > MAX_IMPORT_BYTES) throw new Error('That pasted pack is larger than the 2 MB import limit.');
    previewImport(JSON.parse(pasted), 'Pasted JSON');
  } catch (error) { showToast(`Could not read that JSON: ${error.message}`, true); }
}
function previewImport(payload, sourceName) {
  currentImport = validatePack(payload);
  hide($('importMessage'));
  $('selectedFileName').textContent = sourceName;
  $('selectedFileSummary').textContent = `${currentImport.items.length} word${currentImport.items.length === 1 ? '' : 's'} ready to import`;
  hide($('fileImportEmpty')); show($('selectedFileState'));
}

function resetImportPreview() {
  currentImport = null;
  $('jsonFileInput').value = '';
  hide($('selectedFileState')); show($('fileImportEmpty'));
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
  await Promise.all([loadToday(), renderTopics(), renderLibrary()]);
}

function makeWordRow(item, { marker, side, kind = 'library', onSideClick } = {}) {
  const row = document.createElement('article'); row.className = `${kind}-row`;
  const badge = document.createElement('div'); badge.className = kind === 'topic' ? 'topic-number' : `library-mark${item.status === 'learned' ? ' learned' : ''}`; badge.textContent = marker;
  const copy = document.createElement('button'); copy.className = 'row-copy'; copy.type = 'button'; copy.setAttribute('aria-label', `View details for ${item.term}`); copy.addEventListener('click', () => openDetails(item));
  const term = document.createElement('strong'); term.textContent = item.term;
  // Definitions move into the list item's detail sheet, keeping each card
  // symmetrical even when words have meanings of very different lengths.
  row.classList.add('term-only');
  copy.append(term);
  const tail = document.createElement(onSideClick ? 'button' : 'span'); tail.className = 'row-side'; tail.textContent = side;
  if (onSideClick) { tail.type = 'button'; tail.setAttribute('aria-label', `Review ${item.term}`); tail.addEventListener('click', onSideClick); }
  row.append(badge, copy, tail);
  return row;
}

async function renderTopics() {
  const items = await getAllItems();
  const groups = new Map();
  items.forEach((item) => {
    const topic = topicNameFor(item);
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(item);
  });
  $('topicsCount').textContent = `${groups.size} topic${groups.size === 1 ? '' : 's'}`;
  const cards = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([topic, topicItems]) => makeTopicCard(topic, topicItems));
  $('topicsList').replaceChildren(...cards);
  cards.length ? hide($('topicsEmpty')) : show($('topicsEmpty'));
  if (openTopicName && groups.has(openTopicName)) await renderTopicWords(openTopicName, groups.get(openTopicName));
  else if (openTopicName) showTopicsOverview();
}

function makeTopicCard(topic, items) {
  const card = document.createElement('button'); card.className = 'topic-card'; card.type = 'button'; card.setAttribute('aria-label', `Open ${topic}`);
  const mark = document.createElement('span'); mark.className = 'topic-mark'; mark.setAttribute('aria-hidden', 'true'); mark.append(createTopicIcon(topic));
  const name = document.createElement('strong'); name.className = 'topic-card-name'; name.textContent = topic;
  const count = document.createElement('span'); count.className = 'topic-card-count'; count.textContent = `${topicProgress(items)} / ${items.length}`;
  const arrow = document.createElement('span'); arrow.className = 'row-side'; arrow.textContent = '›';
  card.append(mark, name, count, arrow);
  card.addEventListener('click', () => openTopic(topic));
  return card;
}

function createTopicIcon(topic) {
  const normalized = topic.toLocaleLowerCase();
  let symbol = 'icon-topics';
  if (/(analysis|research|study|thinking|critical)/.test(normalized)) symbol = 'icon-topic-search';
  else if (/(communicat|conversation|meeting|language|writing|speaking)/.test(normalized)) symbol = 'icon-topic-chat';
  else if (/(decision|strategy|planning|direction)/.test(normalized)) symbol = 'icon-topic-compass';
  else if (/(read|literature|book|everyday)/.test(normalized)) symbol = 'icon-topic-book';
  else if (/(leader|team|people|management)/.test(normalized)) symbol = 'icon-topic-people';
  else if (/(negotiat|sales|relationship|agreement)/.test(normalized)) symbol = 'icon-topic-handshake';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

async function openTopic(topic) {
  openTopicName = topic;
  hide($('topicsOverview')); show($('topicDetail'));
  const items = (await getAllItems()).filter((item) => topicNameFor(item) === topic);
  await renderTopicWords(topic, items);
}

async function renderTopicWords(topic, items) {
  if (!items) items = (await getAllItems()).filter((item) => topicNameFor(item) === topic);
  $('topicBreadcrumb').textContent = `TOPICS / ${topic}`;
  $('topicDetailName').textContent = topic;
  $('topicDetailCount').textContent = `${topicProgress(items)} / ${items.length} words covered`;
  $('topicDetailProgress').style.width = `${items.length ? (topicProgress(items) / items.length) * 100 : 0}%`;
  const queued = items.filter((item) => item.status === 'queued').sort((a, b) => a.queuePosition - b.queuePosition);
  $('topicWordList').replaceChildren(...queued.map((item, index) => makeWordRow(item, { kind: 'topic', marker: String(index + 1), side: '›' })));
  queued.length ? hide($('topicWordsEmpty')) : show($('topicWordsEmpty'));
}

function showTopicsOverview() {
  openTopicName = null;
  hide($('topicDetail')); show($('topicsOverview'));
}

async function renderLibrary() {
  const query = $('librarySearch').value.trim().toLocaleLowerCase();
  const all = await getAllItems();
  const visible = all.filter((item) => (libraryFilter === 'favorite' ? item.isFavorite : item.status === libraryFilter) && `${item.term} ${item.meaning} ${item.category} ${item.explanation} ${item.origin} ${(item.synonyms || []).join(' ')} ${item.type} ${item.difficulty}`.toLocaleLowerCase().includes(query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('libraryCount').textContent = `${all.length} word${all.length === 1 ? '' : 's'}`;
  $('libraryList').replaceChildren(...visible.map((item) => {
    const dueForReview = item.status === 'review' && item.reviewDueDate && item.reviewDueDate <= todayKey();
    // Keep these status markers quiet and monochrome so the Library does not
    // introduce the coloured emoji styling that mobile browsers apply.
    const marker = item.isFavorite ? '★' : item.status === 'review' ? '↻' : item.status === 'learned' ? '✓' : '○';
    return makeWordRow(item, { marker, side: dueForReview ? '✓' : '›', onSideClick: dueForReview ? () => completeReview(item) : null });
  }));
}

async function toggleFavorite(item) {
  const updated = { ...item, isFavorite: !item.isFavorite };
  await saveItem(updated);
  if (currentTodayItem?.id === updated.id) currentTodayItem = updated;
  showToast(updated.isFavorite ? 'Saved to favorites.' : 'Removed from favorites.');
  await Promise.all([loadToday(), renderLibrary()]);
}

async function renderReviews() {
  // Reviews live in the Library's "Review" filter in this layout.
  return (await getAllItems()).filter((item) => item.status === 'review' && item.reviewDueDate && item.reviewDueDate <= todayKey());
}

async function completeReview(item) {
  const nextStage = (item.reviewStage ?? -1) + 1;
  const updated = nextStage >= REVIEW_INTERVALS_DAYS.length
    ? { ...item, status: 'learned', reviewStage: nextStage, reviewDueDate: null, learnedAt: new Date().toISOString() }
    : { ...item, status: 'review', reviewStage: nextStage, reviewDueDate: addDaysKey(REVIEW_INTERVALS_DAYS[nextStage]) };
  await saveItem(updated);
  await countTowardDailyGoal(updated.id);
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
    if (file.size > MAX_BACKUP_BYTES) throw new Error('That backup is larger than the 10 MB restore limit.');
    const backup = JSON.parse(await file.text());
    if (!isPlainRecord(backup) || backup.wordflowBackupVersion !== 1) throw new Error('This is not a WordFlow backup.');
    // Validate every field before the confirmation prompt or any IndexedDB
    // write. A malformed file must never clear part of the local library.
    const restoredState = validateStoredState(backup, 'Backup');
    if (!window.confirm('Restore this backup? It will replace the WordFlow data on this device.')) return;
    // Make an explicit user-initiated restore the newest local snapshot, then
    // replace items and settings atomically in one IndexedDB transaction.
    restoredState.settings.lastChangedAt = new Date().toISOString();
    await replaceStoredState(restoredState.items, restoredState.settings);
    settings = restoredState.settings;
    markCloudChangesPending();
    queueCloudSync();
    applyTheme();
    createReminderTimeFields(); scheduleReminders();
    await Promise.all([loadToday(), renderTopics(), renderLibrary(), updateNotificationStatus()]);
    showBackupMessage('Backup restored successfully.');
  } catch (error) { showBackupMessage(error.message, true); } finally { event.target.value = ''; }
}

function showBackupMessage(message, isError = false) { $('backupMessage').className = `message${isError ? ' error' : ''}`; $('backupMessage').textContent = message; show($('backupMessage')); }
async function copyMasterPrompt() { try { await navigator.clipboard.writeText(MASTER_PROMPT); showToast('Prompt copied.'); } catch { showToast('Could not copy the prompt.', true); } }
function showToast(message, isError = false) { let toast = $('globalToast'); if (!toast) { toast = document.createElement('div'); toast.id = 'globalToast'; document.body.appendChild(toast); } toast.className = `toast${isError ? ' error' : ''}`; toast.textContent = message; show(toast); clearTimeout(window.wordflowToastTimer); window.wordflowToastTimer = setTimeout(() => hide(toast), 3200); }

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; show($('installBtn')); });
$('installBtn')?.addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; hide($('installBtn')); });
// Ignore the temporary hash used by a returning magic link until the cloud
// session has completed its first safe download/upload reconciliation.
window.addEventListener('hashchange', () => { if (cloudReadyForUserId) navigate(location.hash.slice(1)); });
window.addEventListener('offline', () => updateSyncControl());
window.addEventListener('online', () => {
  updateSyncControl();
  if (supabaseClient && supabaseSession && hasPendingCloudChanges) queueCloudSync(0);
});

async function boot() {
  try {
    db = await openDatabase();
    await registerServiceWorker();
    await loadSettings();
    // Capture the persisted state before harmless first-paint bookkeeping can
    // change its timestamp. This protects a newer device's cloud library.
    cloudSyncBaselineChangedAt = settings.lastChangedAt;
    await upgradeStoredItems(); $('masterPrompt').textContent = MASTER_PROMPT;
    applyTheme();
    createReminderTimeFields(); wireEvents();
    // Open the offline-first library immediately. Saved authentication and
    // cloud reconciliation complete quietly after the screen is usable.
    showApplication();
    scheduleReminders();
    const initialRoute = requestedRoute();
    const authCallback = isSupabaseCallback();
    if (initialRoute === 'today') await loadToday({ allowMutations: false });
    else navigate(initialRoute);
    bootstrappingLocalState = false;
    // Do not replace a magic-link fragment until Supabase has consumed it.
    void initializeCloudSync().finally(() => {
      cloudReconciliationComplete = true;
      if (initialRoute === 'today') void loadToday();
      else if (authCallback) navigate(initialRoute);
    });
  } catch (error) { console.error(error); document.querySelector('.app-shell').textContent = `WordFlow could not start: ${error.message}`; }
}

boot();
