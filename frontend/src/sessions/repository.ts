import { SESSION_STORES, openPromptAgentDatabase } from "./database";
import {
  PROMPT_AGENT_CHANGE_CHANNEL,
  type PromptAgentAttachment,
  type PromptAgentMessage,
  type PromptAgentPreference,
  type PromptAgentPreferenceValue,
  type PromptAgentProfileCache,
  type PromptAgentSession,
  type SessionChangeEntity,
  type SessionChangeNotification,
  type SessionChangeOperation,
} from "./schema";

export interface PromptAgentChangeChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export type PromptAgentChangeChannelFactory = (name: string) => PromptAgentChangeChannel | undefined;
export type SessionChangeListener = (notification: SessionChangeNotification) => void;

const createChangeChannel: PromptAgentChangeChannelFactory = (name) => {
  if (typeof BroadcastChannel === "undefined") return undefined;
  try {
    return new BroadcastChannel(name);
  } catch {
    return undefined;
  }
};

const SESSION_CHANGE_ENTITIES: SessionChangeEntity[] = ["session", "message", "attachment", "preference", "profile-cache"];
const SESSION_CHANGE_OPERATIONS: SessionChangeOperation[] = ["put", "delete"];

function isSessionChangeNotification(value: unknown): value is SessionChangeNotification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === "session-change"
    && SESSION_CHANGE_ENTITIES.includes(candidate.entity as SessionChangeEntity)
    && SESSION_CHANGE_OPERATIONS.includes(candidate.operation as SessionChangeOperation)
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && (candidate.sessionId === undefined || typeof candidate.sessionId === "string");
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
  });

async function withDatabase<T>(
  openDatabase: () => Promise<IDBDatabase>,
  operation: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

export class PromptAgentSessionRepository {
  private readonly channel: PromptAgentChangeChannel | undefined;
  private readonly listeners = new Set<SessionChangeListener>();
  private readonly handleChannelMessage = (event: MessageEvent): void => {
    if (!isSessionChangeNotification(event.data)) return;
    for (const listener of this.listeners) listener(event.data);
  };

  constructor(
    private readonly openDatabase: () => Promise<IDBDatabase> = openPromptAgentDatabase,
    createChannel: PromptAgentChangeChannelFactory = createChangeChannel,
  ) {
    this.channel = createChannel(PROMPT_AGENT_CHANGE_CHANNEL);
    if (this.channel) this.channel.onmessage = this.handleChannelMessage;
  }

  subscribe(listener: SessionChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.channel) {
      if (this.channel.onmessage === this.handleChannelMessage) this.channel.onmessage = null;
      this.channel.close();
    }
    this.listeners.clear();
  }

  async putSession(session: PromptAgentSession): Promise<void> {
    await withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.sessions, "readwrite");
      transaction.objectStore(SESSION_STORES.sessions).put(toSessionRecord(session));
      await transactionComplete(transaction);
    });
    this.publish("session", "put", session.id);
  }

  async getSession(id: string): Promise<PromptAgentSession | undefined> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.sessions, "readonly");
      return requestResult(transaction.objectStore(SESSION_STORES.sessions).get(id));
    });
  }

  async listSessions(): Promise<PromptAgentSession[]> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.sessions, "readonly");
      const sessions = await requestResult(transaction.objectStore(SESSION_STORES.sessions).getAll()) as PromptAgentSession[];
      return sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    const deleted = await withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction([
        SESSION_STORES.sessions,
        SESSION_STORES.messages,
        SESSION_STORES.attachments,
      ], "readwrite");
      const sessions = transaction.objectStore(SESSION_STORES.sessions);
      const messages = transaction.objectStore(SESSION_STORES.messages);
      const attachments = transaction.objectStore(SESSION_STORES.attachments);
      const completion = transactionComplete(transaction);
      const session = await requestResult(sessions.get(id));
      if (!session) {
        await completion;
        return false;
      }
      const messageKeys = await requestResult(messages.index("sessionId").getAllKeys(IDBKeyRange.only(id)));
      const attachmentKeys = await requestResult(attachments.index("sessionId").getAllKeys(IDBKeyRange.only(id)));
      sessions.delete(id);
      for (const key of messageKeys) messages.delete(key);
      for (const key of attachmentKeys) attachments.delete(key);
      await completion;
      return true;
    });
    if (deleted) this.publish("session", "delete", id, id);
    return deleted;
  }

  async putMessage(message: PromptAgentMessage): Promise<void> {
    await withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.messages, "readwrite");
      transaction.objectStore(SESSION_STORES.messages).put(toMessageRecord(message));
      await transactionComplete(transaction);
    });
    this.publish("message", "put", message.id, message.sessionId);
  }

  async getMessage(id: string): Promise<PromptAgentMessage | undefined> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.messages, "readonly");
      return requestResult(transaction.objectStore(SESSION_STORES.messages).get(id));
    });
  }

  async getMessages(sessionId: string): Promise<PromptAgentMessage[]> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.messages, "readonly");
      const index = transaction.objectStore(SESSION_STORES.messages).index("sessionId");
      const messages = await requestResult(index.getAll(IDBKeyRange.only(sessionId))) as PromptAgentMessage[];
      return messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    });
  }

  async deleteMessage(id: string): Promise<boolean> {
    const deleted = await this.deleteById(SESSION_STORES.messages, id);
    if (deleted) this.publish("message", "delete", id);
    return deleted;
  }

  async putAttachment(attachment: PromptAgentAttachment): Promise<void> {
    const record = toAttachmentRecord(attachment);
    await withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.attachments, "readwrite");
      transaction.objectStore(SESSION_STORES.attachments).put(record);
      await transactionComplete(transaction);
    });
    this.publish("attachment", "put", record.id, record.sessionId);
  }

  async getAttachment(id: string): Promise<PromptAgentAttachment | undefined> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.attachments, "readonly");
      return requestResult(transaction.objectStore(SESSION_STORES.attachments).get(id));
    });
  }

  async listAttachments(sessionId: string): Promise<PromptAgentAttachment[]> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.attachments, "readonly");
      const index = transaction.objectStore(SESSION_STORES.attachments).index("sessionId");
      const attachments = await requestResult(index.getAll(IDBKeyRange.only(sessionId))) as PromptAgentAttachment[];
      return attachments.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    });
  }

  async deleteAttachment(id: string): Promise<boolean> {
    const deleted = await this.deleteById(SESSION_STORES.attachments, id);
    if (deleted) this.publish("attachment", "delete", id);
    return deleted;
  }

  async putPreference(id: string, value: PromptAgentPreferenceValue): Promise<void> {
    const record: PromptAgentPreference = { id, value: toPreferenceValue(value) };
    await withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.preferences, "readwrite");
      transaction.objectStore(SESSION_STORES.preferences).put(record);
      await transactionComplete(transaction);
    });
    this.publish("preference", "put", id);
  }

  async getPreference<T = PromptAgentPreferenceValue>(id: string): Promise<T | undefined> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.preferences, "readonly");
      const record = await requestResult(transaction.objectStore(SESSION_STORES.preferences).get(id)) as PromptAgentPreference | undefined;
      return record?.value as T | undefined;
    });
  }

  async listPreferences(): Promise<PromptAgentPreference[]> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.preferences, "readonly");
      return requestResult(transaction.objectStore(SESSION_STORES.preferences).getAll()) as Promise<PromptAgentPreference[]>;
    });
  }

  async deletePreference(id: string): Promise<boolean> {
    const deleted = await this.deleteById(SESSION_STORES.preferences, id);
    if (deleted) this.publish("preference", "delete", id);
    return deleted;
  }

  async putProfileCache(profile: PromptAgentProfileCache): Promise<void> {
    const record = toProfileCacheRecord(profile);
    await withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.profileCache, "readwrite");
      transaction.objectStore(SESSION_STORES.profileCache).put(record);
      await transactionComplete(transaction);
    });
    this.publish("profile-cache", "put", record.id);
  }

  async getProfileCache(id: string): Promise<PromptAgentProfileCache | undefined> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.profileCache, "readonly");
      return requestResult(transaction.objectStore(SESSION_STORES.profileCache).get(id));
    });
  }

  async listProfileCache(): Promise<PromptAgentProfileCache[]> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.profileCache, "readonly");
      const profiles = await requestResult(transaction.objectStore(SESSION_STORES.profileCache).getAll()) as PromptAgentProfileCache[];
      return profiles.sort((left, right) => right.cachedAt - left.cachedAt || left.id.localeCompare(right.id));
    });
  }

  async deleteProfileCache(id: string): Promise<boolean> {
    const deleted = await this.deleteById(SESSION_STORES.profileCache, id);
    if (deleted) this.publish("profile-cache", "delete", id);
    return deleted;
  }

  async markInterrupted(): Promise<number> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(SESSION_STORES.messages, "readwrite");
      const store = transaction.objectStore(SESSION_STORES.messages);
      const messages = (await requestResult(store.getAll())) as PromptAgentMessage[];
      const unfinished = messages.filter((message) => message.status === "streaming");
      const updatedAt = Date.now();
      for (const message of unfinished) store.put({ ...message, status: "interrupted", updatedAt });
      await transactionComplete(transaction);
      for (const message of unfinished) this.publish("message", "put", message.id, message.sessionId);
      return unfinished.length;
    });
  }

  private async deleteById(storeName: string, id: string): Promise<boolean> {
    return withDatabase(this.openDatabase, async (database) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const completion = transactionComplete(transaction);
      const existing = await requestResult(store.get(id));
      if (existing === undefined) {
        await completion;
        return false;
      }
      store.delete(id);
      await completion;
      return true;
    });
  }

  private publish(entity: SessionChangeEntity, operation: SessionChangeOperation, id: string, sessionId?: string): void {
    if (!this.channel) return;
    const notification: SessionChangeNotification = { type: "session-change", entity, operation, id, ...(sessionId ? { sessionId } : {}) };
    try {
      this.channel.postMessage(notification);
    } catch {
      // Notifications are informational and must not turn a successful write into a failure.
    }
  }
}

function toSessionRecord(session: PromptAgentSession): PromptAgentSession {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    profileId: session.profileId,
    providerId: session.providerId,
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    systemPrompt: session.systemPrompt,
    schemaVersion: session.schemaVersion,
  };
}

function toMessageRecord(message: PromptAgentMessage): PromptAgentMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    message: message.message,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function toAttachmentRecord(attachment: PromptAgentAttachment): PromptAgentAttachment {
  if (!(attachment.blob instanceof Blob)) throw new TypeError("Session attachments must contain a Blob");
  return {
    id: attachment.id,
    sessionId: attachment.sessionId,
    ...(attachment.messageId ? { messageId: attachment.messageId } : {}),
    name: attachment.name.split(/[\\/]/).pop() || "attachment",
    mimeType: attachment.mimeType,
    size: attachment.size,
    blob: new Blob([attachment.blob], { type: attachment.mimeType }),
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

function toPreferenceValue(value: PromptAgentPreferenceValue): PromptAgentPreferenceValue {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Preference numbers must be finite");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  throw new TypeError("Preferences must contain primitive values");
}

function toProfileCacheRecord(profile: PromptAgentProfileCache): PromptAgentProfileCache {
  return {
    id: profile.id,
    ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
    ...(profile.modelId !== undefined ? { modelId: profile.modelId } : {}),
    ...(profile.providerId !== undefined ? { providerId: profile.providerId } : {}),
    ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    ...(profile.runtime !== undefined ? { runtime: profile.runtime } : {}),
    ...(profile.capabilities ? {
      capabilities: {
        tools: profile.capabilities.tools,
        vision: profile.capabilities.vision,
        streaming: profile.capabilities.streaming,
        reasoning: profile.capabilities.reasoning,
      },
    } : {}),
    cachedAt: profile.cachedAt,
  };
}
