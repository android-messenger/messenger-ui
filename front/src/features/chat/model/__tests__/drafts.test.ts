import {describe, it, expect, beforeEach} from "vitest";
import {loadDraft, saveDraft, clearDraft, clearAllDrafts, dropPersistedDrafts} from "../drafts";

describe("drafts (per-chat, localStorage)", () => {
    beforeEach(() => { clearAllDrafts(); localStorage.clear(); });

    it("returns '' when there is no draft", () => {
        expect(loadDraft("c1")).toBe("");
    });

    it("round-trips a draft per chat, isolated from other chats", () => {
        saveDraft("c1", "hello");
        saveDraft("c2", "world");
        expect(loadDraft("c1")).toBe("hello");
        expect(loadDraft("c2")).toBe("world");
    });

    it("saving empty text removes the draft (no accumulation)", () => {
        saveDraft("c1", "typing…");
        saveDraft("c1", "");
        expect(loadDraft("c1")).toBe("");
        expect(localStorage.getItem("wolp.drafts.v1")).toBe("{}");
    });

    it("clearDraft removes just that chat's draft", () => {
        saveDraft("c1", "a");
        saveDraft("c2", "b");
        clearDraft("c1");
        expect(loadDraft("c1")).toBe("");
        expect(loadDraft("c2")).toBe("b");
    });

    it("clearAllDrafts wipes everything (logout)", () => {
        saveDraft("c1", "a");
        saveDraft("c2", "b");
        clearAllDrafts();
        expect(loadDraft("c1")).toBe("");
        expect(loadDraft("c2")).toBe("");
    });

    it("ignores an empty chatId", () => {
        saveDraft("", "x");
        expect(loadDraft("")).toBe("");
    });

    // --- F1 work 1б: a secret chat's draft lives in memory only ------------------------------------
    const KEY = "wolp.drafts.v1";
    const onDisk = () => localStorage.getItem(KEY) ?? "";

    it("persist:false keeps the draft in memory and writes nothing to localStorage", () => {
        saveDraft("s1", "secret draft", {persist: false});
        expect(loadDraft("s1")).toBe("secret draft");
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("persist:false removes a copy of that chat's draft already on disk, leaving other chats", () => {
        saveDraft("s1", "typed before the chat became secret");
        saveDraft("c2", "ordinary");
        saveDraft("s1", "typed after", {persist: false});
        expect(onDisk()).not.toContain("typed");
        expect(loadDraft("s1")).toBe("typed after");
        expect(loadDraft("c2")).toBe("ordinary");
    });

    it("clearing a memory-only draft empties it", () => {
        saveDraft("s1", "secret draft", {persist: false});
        saveDraft("s1", "", {persist: false});
        expect(loadDraft("s1")).toBe("");
        saveDraft("s1", "again", {persist: false});
        clearDraft("s1");
        expect(loadDraft("s1")).toBe("");
    });

    it("a chat that stops being secret persists its next draft again", () => {
        saveDraft("s1", "in memory", {persist: false});
        saveDraft("s1", "on disk");
        expect(onDisk()).toContain("on disk");
        expect(loadDraft("s1")).toBe("on disk");
    });

    it("dropPersistedDrafts moves the given chats' drafts from localStorage to memory", () => {
        saveDraft("s1", "was persisted");
        saveDraft("c2", "ordinary");
        dropPersistedDrafts(["s1", "unknown"]);
        expect(onDisk()).not.toContain("was persisted");
        expect(loadDraft("s1")).toBe("was persisted");   // still there for this page's lifetime
        expect(loadDraft("c2")).toBe("ordinary");
        expect(onDisk()).toContain("ordinary");
    });

    it("dropPersistedDrafts with nothing to drop does not touch localStorage", () => {
        dropPersistedDrafts([]);
        dropPersistedDrafts(["nope"]);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("clearAllDrafts wipes memory-only drafts too", () => {
        saveDraft("s1", "secret draft", {persist: false});
        clearAllDrafts();
        expect(loadDraft("s1")).toBe("");
    });
});
