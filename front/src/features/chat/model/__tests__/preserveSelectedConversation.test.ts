import {describe, it, expect} from "vitest";
import {preserveSelectedConversation} from "../preserveSelectedConversation";
import type {ChatSummary} from "@/entities/conversation";

const sum = (id: string): ChatSummary => ({
    conversationId: id, kind: "direct", counterpartId: "peer-" + id,
    blocked: false, blockedByMe: false, blockedByPeer: false,
});

describe("preserveSelectedConversation", () => {
    it("keeps a just-created selected chat that the refetched list hides (the create regression)", () => {
        const previous = [sum("existing"), sum("new")];   // "new" was injected by AddUser
        const fresh = [sum("existing")];                   // server still hides the empty "new" chat
        const out = preserveSelectedConversation(fresh, previous, "new");
        expect(out.map((s) => s.conversationId).sort()).toEqual(["existing", "new"]);
    });

    it("does not duplicate the selected chat when the fresh list already has it", () => {
        const fresh = [sum("existing"), sum("new")];
        const out = preserveSelectedConversation(fresh, [sum("new")], "new");
        expect(out.filter((s) => s.conversationId === "new")).toHaveLength(1);
        expect(out).toBe(fresh); // unchanged reference — no needless copy
    });

    it("returns the fresh list untouched when nothing is selected", () => {
        const fresh = [sum("a")];
        expect(preserveSelectedConversation(fresh, [sum("b")], null)).toBe(fresh);
    });

    it("does not resurrect a selected chat that wasn't in the previous list either", () => {
        const fresh = [sum("a")];
        // selected id is unknown to both lists (e.g. already gone) → nothing to preserve
        expect(preserveSelectedConversation(fresh, [sum("a")], "ghost")).toBe(fresh);
    });

    it("drops non-selected conversations that the server removed (follows the server list)", () => {
        const previous = [sum("a"), sum("b")];
        const fresh = [sum("a")];                          // "b" legitimately gone, not selected
        const out = preserveSelectedConversation(fresh, previous, "a");
        expect(out.map((s) => s.conversationId)).toEqual(["a"]);
    });
});
