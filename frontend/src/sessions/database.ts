import {
  PROMPT_AGENT_DATABASE,
  PROMPT_AGENT_DATABASE_VERSION,
} from "./schema";

export const SESSION_STORES = {
  sessions: "sessions",
  messages: "messages",
  attachments: "attachments",
  preferences: "preferences",
  runtimePreferences: "preferences",
  profileCache: "profile-cache",
} as const;

const LEGACY_PREFERENCES_STORE = "runtime-preferences";

function createStore(database: IDBDatabase, name: string): IDBObjectStore {
  return database.createObjectStore(name, { keyPath: "id" });
}

function createCurrentStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(SESSION_STORES.sessions)) createStore(database, SESSION_STORES.sessions);
  if (!database.objectStoreNames.contains(SESSION_STORES.messages)) {
    const messages = createStore(database, SESSION_STORES.messages);
    messages.createIndex("sessionId", "sessionId", { unique: false });
  }
  if (!database.objectStoreNames.contains(SESSION_STORES.attachments)) {
    const attachments = createStore(database, SESSION_STORES.attachments);
    attachments.createIndex("sessionId", "sessionId", { unique: false });
  }
  if (!database.objectStoreNames.contains(SESSION_STORES.preferences)) createStore(database, SESSION_STORES.preferences);
  if (!database.objectStoreNames.contains(SESSION_STORES.profileCache)) createStore(database, SESSION_STORES.profileCache);
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

function isSafePreferenceValue(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function migrateVersionOneToTwo(database: IDBDatabase, transaction: IDBTransaction): void {
  const messages = database.objectStoreNames.contains(SESSION_STORES.messages)
    ? transaction.objectStore(SESSION_STORES.messages)
    : createStore(database, SESSION_STORES.messages);
  ensureIndex(messages, "sessionId", "sessionId");

  const attachments = database.objectStoreNames.contains(SESSION_STORES.attachments)
    ? transaction.objectStore(SESSION_STORES.attachments)
    : createStore(database, SESSION_STORES.attachments);
  ensureIndex(attachments, "sessionId", "sessionId");

  if (!database.objectStoreNames.contains(SESSION_STORES.sessions)) createStore(database, SESSION_STORES.sessions);
  if (!database.objectStoreNames.contains(SESSION_STORES.profileCache)) createStore(database, SESSION_STORES.profileCache);

  const preferences = database.objectStoreNames.contains(SESSION_STORES.preferences)
    ? transaction.objectStore(SESSION_STORES.preferences)
    : createStore(database, SESSION_STORES.preferences);
  if (!database.objectStoreNames.contains(LEGACY_PREFERENCES_STORE)) return;

  const legacy = transaction.objectStore(LEGACY_PREFERENCES_STORE);
  const cursorRequest = legacy.openCursor();
  cursorRequest.onerror = () => transaction.abort();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      database.deleteObjectStore(LEGACY_PREFERENCES_STORE);
      return;
    }
    const record = cursor.value as { id?: unknown; value?: unknown };
    if (typeof record.id === "string" && record.id.length > 0 && isSafePreferenceValue(record.value)) {
      preferences.put({ id: record.id, value: record.value });
    }
    cursor.continue();
  };
}

function migrateDatabase(database: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  if (oldVersion < 1) createCurrentStores(database);
  if (oldVersion < 2) migrateVersionOneToTwo(database, transaction);
}

export const openPromptAgentDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(PROMPT_AGENT_DATABASE, PROMPT_AGENT_DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open session database"));
    request.onblocked = () => reject(new Error("Session database upgrade is blocked by another tab"));
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (!transaction) throw new Error("Session database upgrade has no transaction");
      migrateDatabase(request.result, transaction, event.oldVersion);
    };
    request.onsuccess = () => resolve(request.result);
  });
