/*
 * WordFlow V1 deliberately runs without a server, account, or API key.
 * IndexedDB is the browser's durable local database: it survives refreshes and
 * offline use, but data stays on this device until the user exports it.
 */

const DB_NAME = 'wordflow-local';
const DB_VERSION = 1;
const ITEM_STORE = 'items';
const SETTINGS_STORE = 'settings';
const DEFAULT_REMINDER_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00'];
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

const $ = (id) => document.getElementById(id);
const show = (element) => element?.classList.remove('hidden');
const hide = (element) => element?.classList.add('hidden');
const normalizeTerm = (value) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const todayKey = () => new Date().toLocaleDateString('en-CA');
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
async function saveItem(item) { return requestValue(transaction(ITEM_STORE, 'readwrite').put(item)); }
async function removeItem(id) { return requestValue(transaction(ITEM_STORE, 'readwrite').delete(id)); }
async function getSetting(key) { const row = await requestValue(transaction(SETTINGS_STORE).get(key)); return row?.value; }
async function saveSetting(key, value) { return requestValue(transaction(SETTINGS_STORE, 'readwrite').put({ key, value })); }

function defaultSettings() { return { reminderTimes: DEFAULT_REMINDER_TIMES, todayDate: null, todayItemId: null, remindersEnabled: false }; }
async function loadSettings() { settings = { ...defaultSettings(), ...(await getSetting('app')) }; await persistSettings(); }
async function persistSettings() { await saveSetting('app', settings); }

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
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $('refreshTodayBtn').addEventListener('click', () => loadToday());
  $('knowBtn').addEventListener('click', () => updateTodayStatus('learned'));
  $('reviewBtn').addEventListener('click', () => updateTodayStatus('review'));
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
  const allowed = ['today', 'queue', 'library', 'add', 'import', 'settings'];
  const target = allowed.includes(section) ? section : 'today';
  document.querySelectorAll('[data-section]').forEach((element) => element.classList.toggle('hidden', element.dataset.section !== target));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.nav === target));
  history.replaceState(null, '', `#${target}`);
  if (target === 'today') loadToday();
  if (target === 'queue') renderQueue();
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
  $('knowBtn').textContent = currentTodayItem.status === 'learned' ? '✓ Learned' : '✓ I know this';
  $('reviewBtn').textContent = currentTodayItem.status === 'review' ? 'In review' : 'Review later';
  await updateNotificationStatus();
}

async function updateTodayStatus(status) {
  if (!currentTodayItem) return;
  const updated = { ...currentTodayItem, status };
  if (status === 'learned') updated.learnedAt = new Date().toISOString();
  await saveItem(updated); currentTodayItem = updated;
  showToast(status === 'learned' ? 'Great work — this word is now learned.' : 'Added to your review list.');
  await Promise.all([loadToday(), renderQueue(), renderLibrary()]);
}

function buildItem(raw, queuePosition) {
  return { id: uid(), term: raw.term.trim(), normalizedTerm: normalizeTerm(raw.term), type: raw.type.trim(), meaning: raw.meaning.trim(), explanation: (raw.explanation || '').trim(), category: (raw.category || '').trim(), difficulty: (raw.difficulty || '').trim(), examples: raw.examples.map((example) => example.trim()), status: 'queued', queuePosition, createdAt: new Date().toISOString(), startedOn: null, learnedAt: null };
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

function makeListRow(item, actionLabel, action) {
  const row = document.createElement('article'); row.className = 'list-item';
  const main = document.createElement('div'); main.className = 'list-main';
  const term = document.createElement('div'); term.className = 'list-term'; term.textContent = item.term;
  const meta = document.createElement('div'); meta.className = 'list-meta'; meta.textContent = `${item.type} · ${item.status}`;
  const meaning = document.createElement('div'); meaning.className = 'list-meaning'; meaning.textContent = item.meaning;
  main.append(term, meta, meaning); row.appendChild(main);
  if (actionLabel) { const button = document.createElement('button'); button.className = 'mini-btn'; button.textContent = actionLabel; button.addEventListener('click', action); row.appendChild(button); }
  return row;
}

async function renderQueue() {
  const items = (await getAllItems()).filter((item) => item.status === 'queued').sort((a, b) => a.queuePosition - b.queuePosition);
  $('queueList').replaceChildren(...items.map((item) => makeListRow(item, 'Remove', async () => { await removeItem(item.id); showToast('Removed from the queue.'); renderQueue(); renderLibrary(); })));
  items.length ? hide($('queueEmpty')) : show($('queueEmpty'));
}

async function renderLibrary() {
  const query = $('librarySearch').value.trim().toLocaleLowerCase();
  const all = await getAllItems();
  const visible = all.filter((item) => (libraryFilter === 'all' || item.status === libraryFilter) && `${item.term} ${item.meaning} ${item.category}`.toLocaleLowerCase().includes(query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('libraryCount').textContent = `${all.length} word${all.length === 1 ? '' : 's'}`;
  $('libraryList').replaceChildren(...visible.map((item) => makeListRow(item, item.status === 'learned' ? 'Learn again' : 'Mark learned', async () => { await saveItem({ ...item, status: item.status === 'learned' ? 'review' : 'learned', learnedAt: item.status === 'learned' ? null : new Date().toISOString() }); renderLibrary(); renderQueue(); loadToday(); })));
}

async function enableNotifications() {
  if (!('Notification' in window)) return showToast('This browser does not support notifications.', true);
  const permission = await Notification.requestPermission(); settings.remindersEnabled = permission === 'granted'; await persistSettings(); scheduleReminders(); await updateNotificationStatus();
  showToast(permission === 'granted' ? 'Reminders enabled while WordFlow is open.' : 'Notification permission was not granted.', permission !== 'granted');
}

async function updateNotificationStatus() {
  const enabled = settings.remindersEnabled && globalThis.Notification?.permission === 'granted';
  $('notificationBtn').textContent = enabled ? 'Enabled' : 'Enable'; $('notificationBtn').disabled = enabled;
  $('notificationStatus').textContent = enabled ? `Enabled · ${settings.reminderTimes.join(', ')}` : `Not enabled · ${settings.reminderTimes.join(', ')}`;
}

function scheduleReminders() {
  // Timers cannot wake a closed browser. This transparent V1 implementation is
  // local by design; real closed-app push is intentionally deferred.
  reminderTimers.forEach(clearTimeout); reminderTimers = [];
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
  if (times.some((time) => !/^\d{2}:\d{2}$/.test(time)) || new Set(times).size !== 5) return showToast('Choose five different reminder times.', true);
  settings.reminderTimes = times.sort(); await persistSettings(); scheduleReminders(); await updateNotificationStatus(); showToast('Reminder times saved.');
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
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));

async function boot() {
  try {
    db = await openDatabase();
    if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
    await loadSettings(); $('masterPrompt').textContent = MASTER_PROMPT;
    createManualExampleFields(); createReminderTimeFields(); wireEvents(); scheduleReminders(); navigate(location.hash.slice(1) || 'today');
  } catch (error) { console.error(error); document.querySelector('.content').textContent = `WordFlow could not start: ${error.message}`; }
}

boot();
