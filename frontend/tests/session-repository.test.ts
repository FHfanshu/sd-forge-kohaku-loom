import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SESSION_STORES, openPromptAgentDatabase } from "../src/sessions/database";
import { PromptAgentSessionRepository } from "../src/sessions/repository";
import {
  PROMPT_AGENT_DATABASE,
  PROMPT_AGENT_DATABASE_VERSION,
  type PromptAgentAttachment,
  type PromptAgentSession,
} from "../src/sessions/schema";

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PROMPT_AGENT_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked"));
  });

const userMessage = (text: string, timestamp: number): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});

const session = (id: string, updatedAt = 1): PromptAgentSession => ({
  id,
  title: "Session",
  createdAt: 1,
  updatedAt,
  profileId: "profile",
  providerId: "provider",
  modelId: "model",
  reasoningLevel: "off",
  systemPrompt: "",
  schemaVersion: 1,
});

const attachment = (id: string, sessionId: string): PromptAgentAttachment => ({
  id,
  sessionId,
  name: "C:\\private\\reference.png",
  mimeType: "image/png",
  size: 3,
  blob: new Blob(["png"], { type: "image/png" }),
  createdAt: 1,
  updatedAt: 1,
});

const openDatabaseAtVersion = (version: number): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(PROMPT_AGENT_DATABASE, version);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("sessions", { keyPath: "id" });
      const messages = database.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("sessionId", "sessionId", { unique: false });
      database.createObjectStore("attachments", { keyPath: "id" });
      database.createObjectStore("runtime-preferences", { keyPath: "id" });
      database.createObjectStore("profile-cache", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
  });

const createLegacyV1Database = async (): Promise<void> => {
  const database = await openDatabaseAtVersion(1);
  const transaction = database.transaction([
    "sessions",
    "messages",
    "runtime-preferences",
  ], "readwrite");
  const preferences = transaction.objectStore("runtime-preferences");
  transaction.objectStore("sessions").put(session("migrated"));
  transaction.objectStore("messages").put({
    id: "migrated-message",
    sessionId: "migrated",
    message: userMessage("migrated", 1),
    status: "complete",
    createdAt: 1,
    updatedAt: 1,
  });
  preferences.put({ id: "legacy", value: "retained" });
  preferences.put({ id: "unsafe", value: { apiKey: "secret", modelPath: "C:\\private\\model.gguf" } });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
};

class TestChangeChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  close(): void {
    this.onmessage = null;
  }
}

describe("PromptAgentSessionRepository", () => {
  beforeEach(deleteDatabase);
  afterEach(deleteDatabase);

  it("persists sorted sessions, messages, and preferences", async () => {
    const repository = new PromptAgentSessionRepository();
    await repository.putSession(session("older", 10));
    await repository.putSession(session("newer", 20));
    await repository.putMessage({ id: "later", sessionId: "newer", message: userMessage("later", 20), status: "complete", createdAt: 20, updatedAt: 20 });
    await repository.putMessage({ id: "earlier", sessionId: "newer", message: userMessage("earlier", 10), status: "complete", createdAt: 10, updatedAt: 10 });
    await repository.putPreference("last-session-id", "newer");

    expect((await repository.listSessions()).map((session) => session.id)).toEqual(["newer", "older"]);
    expect((await repository.getMessages("newer")).map((message) => message.id)).toEqual(["earlier", "later"]);
    expect(await repository.getPreference("last-session-id")).toBe("newer");
    expect(await repository.listPreferences()).toEqual([{ id: "last-session-id", value: "newer" }]);
    expect(await repository.deletePreference("last-session-id")).toBe(true);
    expect(await repository.getPreference("last-session-id")).toBeUndefined();
    repository.close();
  });

  it("marks only unfinished streaming messages interrupted", async () => {
    const repository = new PromptAgentSessionRepository();
    await repository.putMessage({ id: "streaming", sessionId: "session", message: userMessage("partial", 1), status: "streaming", createdAt: 1, updatedAt: 1 });
    await repository.putMessage({ id: "complete", sessionId: "session", message: userMessage("done", 2), status: "complete", createdAt: 2, updatedAt: 2 });

    expect(await repository.markInterrupted()).toBe(1);
    expect((await repository.getMessages("session")).map((message) => message.status)).toEqual(["interrupted", "complete"]);
    repository.close();
  });

  it("creates the versioned v2 stores and migrates v1 preferences", async () => {
    await createLegacyV1Database();

    const repository = new PromptAgentSessionRepository();
    expect(await repository.getPreference("legacy")).toBe("retained");
    expect(await repository.getPreference("unsafe")).toBeUndefined();
    expect(await repository.getSession("migrated")).toEqual(session("migrated"));
    expect(await repository.getMessage("migrated-message")).toBeDefined();
    const database = await openPromptAgentDatabase();
    expect(database.version).toBe(PROMPT_AGENT_DATABASE_VERSION);
    expect(Array.from(database.objectStoreNames)).toEqual(expect.arrayContaining([
      SESSION_STORES.sessions,
      SESSION_STORES.messages,
      SESSION_STORES.attachments,
      SESSION_STORES.preferences,
      SESSION_STORES.profileCache,
    ]));
    expect(Array.from(database.objectStoreNames)).not.toContain("runtime-preferences");
    expect(Array.from(database.transaction(SESSION_STORES.attachments, "readonly").objectStore(SESSION_STORES.attachments).indexNames)).toContain("sessionId");
    database.close();
    repository.close();
  });

  it("creates only the current stores on a fresh database", async () => {
    const database = await openPromptAgentDatabase();
    expect(database.version).toBe(PROMPT_AGENT_DATABASE_VERSION);
    expect(Array.from(database.objectStoreNames)).toEqual(expect.arrayContaining([
      SESSION_STORES.sessions,
      SESSION_STORES.messages,
      SESSION_STORES.attachments,
      SESSION_STORES.preferences,
      SESSION_STORES.profileCache,
    ]));
    expect(Array.from(database.objectStoreNames)).not.toContain("runtime-preferences");
    database.close();
  });

  it("supports CRUD for attachments and secret-free profile cache records", async () => {
    const repository = new PromptAgentSessionRepository();
    await repository.putSession(session("session"));
    await repository.putAttachment(attachment("attachment", "session"));
    expect((await repository.getAttachment("attachment"))?.name).toBe("reference.png");
    expect((await repository.listAttachments("session")).map((item) => item.id)).toEqual(["attachment"]);
    expect(await repository.deleteAttachment("attachment")).toBe(true);
    expect(await repository.getAttachment("attachment")).toBeUndefined();

    const profileWithPrivateFields = {
      id: "profile",
      displayName: "Public",
      modelId: "model",
      providerId: "provider",
      cachedAt: 1,
      capabilities: { tools: true, vision: false, streaming: true, reasoning: false },
      apiKey: "secret",
      modelPath: "C:\\models\\private.gguf",
    };
    await repository.putProfileCache(profileWithPrivateFields);
    const cached = await repository.getProfileCache("profile");
    expect(cached).toEqual(expect.objectContaining({ id: "profile", displayName: "Public", modelId: "model" }));
    expect(cached).not.toHaveProperty("apiKey");
    expect(cached).not.toHaveProperty("modelPath");
    expect(await repository.deleteProfileCache("profile")).toBe(true);
    expect(await repository.getProfileCache("profile")).toBeUndefined();
    repository.close();
  });

  it("upserts streaming snapshots by stable message key", async () => {
    const repository = new PromptAgentSessionRepository();
    await repository.putMessage({ id: "stream", sessionId: "session", message: userMessage("first", 1), status: "streaming", createdAt: 1, updatedAt: 1 });
    await repository.putMessage({ id: "stream", sessionId: "session", message: userMessage("second", 1), status: "complete", createdAt: 1, updatedAt: 2 });

    expect(await repository.getMessages("session")).toHaveLength(1);
    expect((await repository.getMessage("stream"))?.message).toEqual(userMessage("second", 1));
    expect(await repository.deleteMessage("stream")).toBe(true);
    expect(await repository.getMessage("stream")).toBeUndefined();
    repository.close();
  });

  it("deletes a session and its messages and attachments in one transaction", async () => {
    const repository = new PromptAgentSessionRepository();
    await repository.putSession(session("session"));
    await repository.putSession(session("other"));
    await repository.putMessage({ id: "owned-message", sessionId: "session", message: userMessage("owned", 1), status: "complete", createdAt: 1, updatedAt: 1 });
    await repository.putMessage({ id: "other-message", sessionId: "other", message: userMessage("other", 1), status: "complete", createdAt: 1, updatedAt: 1 });
    await repository.putAttachment(attachment("owned-attachment", "session"));
    await repository.putAttachment(attachment("other-attachment", "other"));

    expect(await repository.deleteSession("session")).toBe(true);
    expect(await repository.getSession("session")).toBeUndefined();
    expect(await repository.getMessages("session")).toEqual([]);
    expect(await repository.listAttachments("session")).toEqual([]);
    expect(await repository.getSession("other")).toEqual(session("other"));
    expect(await repository.getMessage("other-message")).toBeDefined();
    expect(await repository.getAttachment("other-attachment")).toBeDefined();
    expect(await repository.deleteSession("missing")).toBe(false);
    repository.close();
  });

  it("delivers informational change notifications without ownership state", async () => {
    const channel = new TestChangeChannel();
    const repository = new PromptAgentSessionRepository(openPromptAgentDatabase, () => channel);
    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);
    await repository.putSession(session("session"));
    expect(channel.messages).toEqual([{
      type: "session-change",
      entity: "session",
      operation: "put",
      id: "session",
    }]);
    channel.onmessage?.(new MessageEvent("message", { data: {
      type: "session-change",
      entity: "session",
      operation: "put",
      id: "session",
    } }));

    expect(listener).toHaveBeenCalledWith({ type: "session-change", entity: "session", operation: "put", id: "session" });
    unsubscribe();
    repository.close();
    expect(channel.onmessage).toBeNull();
  });
});
