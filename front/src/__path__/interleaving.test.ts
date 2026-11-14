import {describe, it, expect, afterEach} from "vitest";
import {bench, stop, row, type Bench} from "./bench";

// Spec 003, SC-005: frames of the socket, answers of the history and drops of the connection come in a
// random order, and whatever the order, a message the client has ACKNOWLEDGED is in the chat. The server
// will never send an acknowledged message again, so one that is not on the screen is lost to the user.
//
// The server of this test answers a history request with what it had stored WHEN THE REQUEST CAME — the
// worst case of a real server, which reads its table and only then takes the next message.

const MY = "me";
const PEER = "peer";
const RUNS = 1000;
const STEPS = 10;

/** mulberry32: the same seed gives the same run. */
function random(seed: number): () => number {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** One run in its own chat. Returns the acknowledged messages the chat does not show. */
async function oneRun(b: Bench, seed: number): Promise<string[]> {
    const rand = random(seed);
    const chatId = `c-${seed}`;
    const stored: ReturnType<typeof row>[] = [];          // the server's table
    const snapshots: ReturnType<typeof row>[][] = [];     // what each waiting request will be answered with
    const server = b.server.history(chatId);
    const noteRequests = async () => {
        await b.tick();
        await b.tick();
        while (snapshots.length < server.waiting()) snapshots.push([...stored]);
    };
    const answer = async () => {
        if (!snapshots.length) return;
        await server.answer(snapshots.shift()!);
        await noteRequests();
    };

    if (!b.socket.isOpen()) b.socket.connect();
    const chat = b.open(chatId);
    await noteRequests();
    const steps: string[] = [];
    for (let i = 0; i < STEPS; i++) {
        const dice = rand();
        if (dice < 0.4) {
            steps.push("message");
            const id = "01ARZ3NDEKTSV4RR" + String(seed * 100 + i).padStart(10, "0");
            const message = row({id, chat: chatId, from: PEER, to: MY, body: `m${i}`, at: 1_700_000_000_000 + i});
            stored.push(message);
            if (b.socket.isOpen()) b.socket.frame(message);
        } else if (dice < 0.65) {
            steps.push("read");
            void chat.reread();
        } else if (dice < 0.9) {
            steps.push("answer");
            await answer();
        } else {
            steps.push("drop");
            b.socket.drop();
            b.socket.connect();
        }
        await noteRequests();
    }
    for (let i = 0; i < 20 && (snapshots.length || server.waiting()); i++) { await noteRequests(); await answer(); }

    const acknowledged = b.socket.sent("CHAT_ACK").filter((f) => f.conversationId === chatId).map((f) => String(f.correlationId));
    const shown = new Set(b.screen(chatId)?.map((m) => m.id));
    chat.close();
    const lost = acknowledged.filter((id) => !shown.has(id));
    return lost.length ? [`seed ${seed} [${steps.join(", ")}]: acknowledged and not shown: ${lost.join(", ")}`] : [];
}

describe("random order of socket frames, history answers and drops (SC-005)", () => {
    afterEach(stop);

    // Fails today: findings 1 and 2 of the audit (tests A1, A2). The mark is taken off by T317.
    it.fails(`in ${RUNS} runs no acknowledged message is missing from the chat`, {timeout: 120_000}, async () => {
        const b = await bench();
        await b.signIn(MY);
        const lost: string[] = [];
        for (let seed = 1; seed <= RUNS; seed++) lost.push(...await oneRun(b, seed));
        expect(lost.slice(0, 5), `${lost.length} of ${RUNS} runs lost a message`).toEqual([]);
    });
});
