import "fake-indexeddb/auto";
import {IDBFactory} from "fake-indexeddb";
import {vi} from "vitest";
import {createElement, type ReactNode} from "react";
import {Provider} from "react-redux";
import toast from "react-hot-toast";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";

// Spec 003, story 1 — the bench of the message path.
//
// A test on the bench runs the REAL application: the store as the app builds it (configureAppStore), the
// real socket middleware, chatApi, the frame handlers, the slices and the disk. The bench plays only what
// is outside the interface:
//   - the server  — answers to requests, given when the test says so;
//   - the socket  — frames in both directions, a drop, a new connection;
//   - the app     — the Android app's bridge: the Vault (open or locked) and `notifyMessage`;
//   - the page    — visible or hidden.
// Nothing of the message path may be mocked in a test that uses the bench (FR-006).
//
// The application's modules are loaded anew for every bench and every restart(), so what they keep in
// module variables starts empty, as after a real start. Tests therefore take the modules from `bench.m`
// and never import them at the top of the file.

const ORIGIN = "http://edge.test";
const API = "/messenger/api";
const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

/** Lets the application's pending work run: promises, and timers that are already due. */
const setImmediate = (globalThis as unknown as {setImmediate: (fn: () => void) => void}).setImmediate;   // Node's
const tick = () => new Promise<void>((r) => setImmediate(r));

/** Waits until `check` is true. Uses the real clock, also under fake timers. */
async function until(check: () => boolean, what: string, ms = 2_000): Promise<void> {
    for (let i = 0; i < 20 && !check(); i++) await tick();
    for (let waited = 0; !check(); waited += 5) {
        if (waited >= ms) throw new Error(`bench: waited ${ms} ms for ${what}`);
        await sleep(5);
    }
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});

/** A message as the server sends it: a CHAT_OUT frame and a row of the history. */
export function row(o: {id: string; chat: string; from: string; to: string; body: string; clientId?: string; at?: number}) {
    return {
        type: "CHAT_OUT", messageId: o.id, conversationId: o.chat, senderId: o.from, recipientId: o.to,
        serverTimestamp: o.at ?? 1_700_000_000_000, payload: {kind: "text", body: o.body},
        ...(o.clientId ? {correlationId: o.clientId} : {}),
    };
}

/** The application's modules a test reaches for. Loaded after the module registry is reset. */
async function load() {
    const [store, logout, api, groups, service, mapper, outbox, chatUi, ws, sync, db, lists, drafts, user, session, kratos, flush, config] =
        await Promise.all([
            import("@/store/store"),
            import("@/store/logout"),
            import("@/features/chat/rest/chatApi"),
            import("@/features/groups/rest/groupApi"),
            import("@/features/chat/model/services/chatMessages.service"),
            import("@/features/chat/model/mapper"),
            import("@/features/chat/model/slices/outboxSlice"),
            import("@/features/chat/model/slices/chatUiSlice"),
            import("@/infrastructure/slices/websocketSlice"),
            import("@/features/chat/model/historySync"),
            import("@/features/chat/db/db"),
            import("@/features/chat/model/sealedLists"),
            import("@/features/chat/model/drafts"),
            import("@/features/auth/slices/userSlice"),
            import("@/features/auth/model/enterSession"),
            import("@/features/auth/model/services/kratos"),
            import("@/features/chat/thunk/sendOutboxThunk"),
            import("@/shared/config/api"),
        ]);
    return {store, logout, api, groups, service, mapper, outbox, chatUi, ws, sync, db, lists, drafts, user, session, kratos, flush, config};
}
export type Modules = Awaited<ReturnType<typeof load>>;

type Frame = Record<string, unknown>;
type NotifyMode = "answers" | "silent" | "refuses" | "absent";

/** What lives through a restart: the server, the app, the record of what was asked and sent. */
interface World {
    isApp: boolean;
    session: {id: string; name: string} | null;
    unauthorized: boolean;
    chats: unknown[];
    always: Map<string, unknown>;
    replies: Array<{method: string; path: RegExp; answer: () => unknown}>;
    requests: Array<{method: string; path: string}>;
    frames: Array<{connection: number; frame: Frame}>;
    connections: number;
    vaultLocked: boolean;
    notify: NotifyMode;
    notified: Frame[];
    appListeners: Map<string, Set<() => void>>;
    errors: string[];
}

/** What one start of the application owns; restart() and stop() end it. */
interface Run {
    dead: boolean;
    held: Array<{chat: string; resolve: (r: Response) => void; reject: (e: Error) => void}>;
    sockets: FakeSocket[];
    timers: Set<unknown>;
    listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, unknown]>;
}

let world: World | null = null;
let run: Run | null = null;
let undo: Array<() => void> = [];

class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    connection = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: {data: string}) => void) | null = null;
    onclose: ((e: {code: number}) => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly owner = run;
    readonly url: string;
    constructor(url: string) {
        this.url = url;
        this.owner?.sockets.push(this);
    }
    send(data: string) {
        if (this.owner?.dead || !world) return;
        world.frames.push({connection: this.connection, frame: JSON.parse(data) as Frame});
    }
    close() { this.readyState = FakeSocket.CLOSED; }
}

/** Ends the running application the way a killed process ends: its timers never fire, its listeners are
 * gone, its sockets are silent, its requests are never answered. What it has already handed to the disk
 * is written. */
function kill(r: Run): void {
    r.dead = true;
    for (const t of r.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    r.timers.clear();
    if (vi.isFakeTimers()) vi.clearAllTimers();
    for (const [target, type, fn, opts] of r.listeners) target.removeEventListener(type, fn, opts as EventListenerOptions);
    r.listeners.length = 0;
    for (const s of r.sockets) { s.onopen = s.onmessage = s.onclose = s.onerror = null; s.readyState = FakeSocket.CLOSED; }
    r.held.length = 0;
    world?.appListeners.clear();
}

/** Puts the bench's fakes in place of the page's globals. Once per bench; removed by stop(). */
function install(w: World): void {
    vi.stubEnv("VITE_API_ORIGIN", ORIGIN);   // the app build: absolute URLs, which Node's Request needs

    // Timers and listeners belong to the application that set them: restart() must be able to end them.
    const realSetInterval = globalThis.setInterval;
    const timer = (real: typeof setTimeout | typeof setInterval, once: boolean) =>
        (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
            const owner = run;
            if (!owner || owner.dead) return realSetTimeout(() => {}, 0);
            const h: unknown = (real as typeof setTimeout)((...a: unknown[]) => {
                if (once) owner.timers.delete(h);
                if (!owner.dead) fn(...a);
            }, ms, ...args);
            owner.timers.add(h);
            return h;
        };
    const ownTimeout = timer(realSetTimeout, true);
    vi.stubGlobal("setTimeout", ownTimeout);
    vi.stubGlobal("setInterval", timer(realSetInterval, false));
    // The page's own animation frame runs on a timer the page sets through the same setTimeout: ended by a
    // restart, it would never tick again. The application gets a frame of its own instead (a store tells its
    // subscribers on the next frame).
    vi.stubGlobal("requestAnimationFrame", (cb: (at: number) => void) => ownTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    for (const target of [document, window] as EventTarget[]) {
        const original = target.addEventListener;
        target.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: unknown) {
            if (!run || run.dead || !fn) return;
            run.listeners.push([target, type, fn, opts]);
            original.call(target, type, fn, opts as AddEventListenerOptions);
        } as typeof target.addEventListener;
        undo.push(() => { target.addEventListener = original; });
    }

    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        const path = url.pathname.replace(API, "") + url.search;
        const owner = run;
        if (!owner || owner.dead) return new Promise<Response>(() => {});
        w.requests.push({method: req.method, path});
        if (w.unauthorized) return Promise.resolve(json({error: "unauthorized"}, 401));
        const reply = w.replies.find((r) => r.method === req.method && r.path.test(path));
        if (reply) {
            const a = reply.answer();
            return Promise.resolve(a instanceof Response ? a : json(a));
        }
        const history = req.method === "GET" ? /^\/chats\/([^/?]+)\/messages/.exec(path) : null;
        if (history) {
            const chat = decodeURIComponent(history[1]);
            if (w.always.has(chat)) return Promise.resolve(json(w.always.get(chat)));
            return new Promise<Response>((resolve, reject) => owner.held.push({chat, resolve, reject}));
        }
        if (req.method === "GET" && path === "/chats") return Promise.resolve(json(w.chats));
        return Promise.resolve(json([]));
    });

    // The session check goes to Kratos over the network: the bench answers it.
    vi.doMock("@/features/auth/model/services/kratos.ts", () => ({
        kratos: {
            toSession: async () => {
                if (w.session && !w.unauthorized) return {data: {identity: {id: w.session.id, traits: {name: w.session.name}}}};
                throw Object.assign(new Error("no session"), {response: {status: 401}});
            },
        },
    }));
    undo.push(() => vi.doUnmock("@/features/auth/model/services/kratos.ts"));

    // The page: visible until the test hides it.
    let hidden = false;
    Object.defineProperty(document, "hidden", {configurable: true, get: () => hidden});
    Object.defineProperty(document, "visibilityState", {configurable: true, get: () => (hidden ? "hidden" : "visible")});
    pageHidden = (v) => { hidden = v; document.dispatchEvent(new Event("visibilitychange")); };
    undo.push(() => {
        delete (document as unknown as Record<string, unknown>).hidden;
        delete (document as unknown as Record<string, unknown>).visibilityState;
    });

    const spy = vi.spyOn(toast, "error").mockImplementation((message) => { w.errors.push(String(message)); return ""; });
    undo.push(() => spy.mockRestore());

    if (w.isApp) installApp(w);
}
let pageHidden: (hidden: boolean) => void = () => {};

/** The Android app: the Vault of the e2ee tests' fake app, with a lock, and the Push plugin. */
function installApp(w: World): void {
    const app = installFakeApp();
    const locked = () => Object.assign(new Error("the phone is locked"), {code: "VAULT_LOCKED"});
    for (const op of ["vaultWrap", "vaultUnwrap"] as const) {
        const real = app.plugin[op].getMockImplementation() as unknown as (o: never) => Promise<never>;
        app.plugin[op].mockImplementation((async (o: never) => {
            if (w.vaultLocked) throw locked();
            return real(o);
        }) as never);
    }
    const notifyMessage = (o: Frame) => {
        w.notified.push(o);
        if (w.notify === "refuses") return Promise.reject(new Error("the app refused"));
        if (w.notify === "silent") return new Promise(() => {});
        return Promise.resolve({shown: false});
    };
    const push: Record<string, unknown> = {
        register: async () => ({result: "ok"}),
        unregister: async () => {},
        updateContactNames: async () => {},
        setForegroundConversation: async () => {},
        wsClosed: async () => {},
        addListener: (event: string, cb: () => void) => {
            const set = w.appListeners.get(event) ?? new Set();
            w.appListeners.set(event, set);
            set.add(cb);
            return Promise.resolve({remove: async () => { set.delete(cb); }});
        },
    };
    // an app before 10191 has no notifyMessage at all
    Object.defineProperty(push, "notifyMessage", {enumerable: true, get: () => (w.notify === "absent" ? undefined : notifyMessage)});
    const plugins = (globalThis as unknown as {Capacitor: {Plugins: Record<string, unknown>}}).Capacitor.Plugins;
    plugins.Push = push;
    plugins.AppSettings = {setLanguage: async () => {}};
    undo.push(app.uninstall);
}

export interface BenchOptions {
    /** The Android app (records on disk go through the Vault) or a browser (the default). */
    app?: boolean;
    /** The phone is locked at the start. Only with `app`. */
    vaultLocked?: boolean;
    /** false — do not wait for the start to read the disk: the test acts while the queue is still being read. */
    settled?: boolean;
}

type Core = ReturnType<typeof assemble>;
export type Bench = Core & {
    /** The application is killed and started again on the same device. Nobody is signed in yet. */
    restart(o?: {settled?: boolean}): Promise<Bench>;
};

/**
 * Starts the application on an empty device. One bench at a time: a bench left running by a failed test
 * is stopped first.
 */
export async function bench(opts: BenchOptions = {}): Promise<Bench> {
    await stop();
    world = {
        isApp: !!opts.app, session: null, unauthorized: false, chats: [], always: new Map(), replies: [],
        requests: [], frames: [], connections: 0, vaultLocked: !!opts.vaultLocked, notify: "answers",
        notified: [], appListeners: new Map(), errors: [],
    };
    vi.stubGlobal("indexedDB", new IDBFactory());   // an empty disk
    localStorage.clear();
    install(world);
    return boot(world, opts.settled !== false);
}

/** Stops the bench and gives the page its globals back. Call it in afterEach. */
export async function stop(): Promise<void> {
    if (run) {
        kill(run);
        // What the killed application had in flight (a write to the disk, a request already answered) runs
        // to its end here, while the page still exists — not after the test file is over.
        for (let i = 0; i < 50; i++) await tick();
        await sleep(20);
    }
    run = null;
    world = null;
    for (const u of undo.reverse()) u();
    undo = [];
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
}

async function boot(w: World, settled: boolean): Promise<Bench> {
    const mine: Run = {dead: false, held: [], sockets: [], timers: new Set(), listeners: []};
    run = mine;
    vi.resetModules();
    const m = await load();
    // As main.tsx: build the store, start reading the disk, do not wait for it.
    const store = m.store.configureAppStore(webrtc);
    const hydrated = m.store.hydrateStore(store);
    if (settled) {
        await hydrated;
        if (!w.vaultLocked) await until(() => m.lists.listsReady(), "the lists to be read from the disk");
    }
    return {
        ...assemble(w, mine, m, store),
        async restart(o = {}) {
            kill(mine);
            for (let i = 0; i < 50; i++) await tick();
            await sleep(20);   // what was already handed to the disk gets written
            return boot(w, o.settled !== false);
        },
    };
}

function assemble(w: World, mine: Run, m: Modules, store: ReturnType<Modules["store"]["configureAppStore"]>) {
    const myId = () => store.getState().user.id;
    const historyArg = (chatId: string) => ({myId: myId(), chatId});
    const openSocket = () => mine.sockets.find((s) => s.readyState === FakeSocket.OPEN);

    return {
        /** The application's store, built by configureAppStore. */
        store,
        /** The application's modules of this start. */
        m,
        /** For renderHook / render: the application's store around the component. */
        wrapper: ({children}: {children: ReactNode}) => createElement(Provider, {store, children}),

        /** The session check finds `id` signed in — the same steps as RequireAuth. */
        async signIn(id = "me", name = id): Promise<void> {
            w.session = {id, name};
            w.unauthorized = false;
            const {data} = await m.kratos.kratos.toSession();
            await m.session.enterSession(store.dispatch, data.identity as {id: string});
        },

        server: {
            /** The history of a chat. A request waits until the test answers it, one answer per request. */
            history(chat: string) {
                const take = async () => {
                    await until(() => mine.held.some((h) => h.chat === chat), `a history request for ${chat}`);
                    return mine.held.splice(mine.held.findIndex((h) => h.chat === chat), 1)[0];
                };
                return {
                    async answer(rows: unknown[], more: Record<string, unknown> = {}) { (await take()).resolve(json({messages: rows, ...more})); },
                    async fail() { (await take()).reject(new TypeError("Failed to fetch")); },
                    async status(code: number) { (await take()).resolve(json({error: String(code)}, code)); },
                    /** From now on every request is answered at once with these rows. */
                    always(rows: unknown[]) { w.always.set(chat, {messages: rows}); },
                    /** Requests waiting for an answer. */
                    waiting: () => mine.held.filter((h) => h.chat === chat).length,
                    /** Requests made since the bench started. */
                    asked: () => w.requests.filter((r) => r.method === "GET" && r.path.startsWith(`/chats/${chat}/messages`)).length,
                };
            },
            /** The chat list the server gives (rows of GET /chats). */
            chats(rows: unknown[]) { w.chats = rows; },
            /** Any other request: `answer()` gives the body, or a Response. */
            reply(method: string, path: RegExp, answer: () => unknown) { w.replies.unshift({method, path, answer}); },
            /** The session has expired: every request gets a 401 until the next signIn. */
            expireSession() { w.unauthorized = true; },
            /** Every request made, in order. */
            requests: () => [...w.requests],
        },

        socket: {
            /** The application connects (as the page does once a user is signed in) and the server accepts. */
            connect(): number {
                store.dispatch({type: "ws/connect", payload: {url: m.config.messengerWsUrl()}, meta: {shouldReconnect: true}});
                return this.accept();
            },
            /** The server accepts the connection the application is making. Returns the connection's number. */
            accept(): number {
                const s = mine.sockets.find((x) => x.readyState === FakeSocket.CONNECTING);
                if (!s) throw new Error("bench: the application is not connecting (is a user signed in?)");
                s.readyState = FakeSocket.OPEN;
                s.connection = ++w.connections;
                s.onopen?.();
                return s.connection;
            },
            /** A frame from the server. */
            frame(frame: Frame): void {
                const s = openSocket();
                if (!s) throw new Error("bench: no open socket");
                s.onmessage?.({data: JSON.stringify(frame)});
            },
            /** The connection is lost (the network, the server). */
            drop(code = 1006): void {
                const s = openSocket();
                if (!s) throw new Error("bench: no open socket");
                s.readyState = FakeSocket.CLOSED;
                s.onclose?.({code});
            },
            isOpen: () => !!openSocket(),
            /** Frames the application sent, of one type or all. */
            sent: (type?: string) => w.frames.map((f) => f.frame).filter((f) => !type || f.type === type),
            /** The same, with the number of the connection each went over. */
            sentWithConnection: () => [...w.frames],
        },

        /** The Android app. Only on a bench started with `app`. */
        app: {
            lock() { w.vaultLocked = true; },
            /** The phone is unlocked: the app comes back to the screen. */
            unlock() { w.vaultLocked = false; document.dispatchEvent(new Event("visibilitychange")); },
            /** How the app takes `notifyMessage`: answers (default), stays silent, refuses, or has no such method. */
            notify(mode: NotifyMode) { w.notify = mode; },
            /** The messages the interface told the app about. */
            notified: () => [...w.notified],
            /** An event of the app: appBackground, appForeground. */
            emit(event: string) { for (const cb of [...(w.appListeners.get(event) ?? [])]) cb(); },
        },

        page: {
            hide() { pageHidden(true); },
            show() { pageHidden(false); },
        },

        /** The user opens the chat: it is selected and its history is read. */
        open(chatId: string) {
            store.dispatch(m.chatUi.setSelectedChatId(chatId));
            const sub = store.dispatch(m.api.chatApi.endpoints.getChatHistory.initiate(historyArg(chatId)));
            return {
                /** Settles when the first read has ended, well or not. */
                read: sub as Promise<unknown>,
                /** The chat is read again: return to the screen, "retry", an attachment was sent. */
                reread: () => store.dispatch(m.api.chatApi.endpoints.getChatHistory.initiate(historyArg(chatId), {forceRefetch: true, subscribe: false})) as Promise<unknown>,
                close() { sub.unsubscribe(); store.dispatch(m.chatUi.setSelectedChatId(null)); },
            };
        },
        /** What the chat shows: its messages in order, or undefined when it has nothing to show. */
        screen(chatId: string) {
            return m.api.chatApi.endpoints.getChatHistory.select(historyArg(chatId))(store.getState() as never).data;
        },
        /** The read of the chat's history has failed and the screen says so. */
        readFailed(chatId: string): boolean {
            return m.api.chatApi.endpoints.getChatHistory.select(historyArg(chatId))(store.getState() as never).isError;
        },
        /** The chat cannot be proved complete and will be read again. */
        stale: (chatId: string) => m.sync.isStale(chatId, store.getState().ws),
        /** The send queue. */
        queue: () => store.getState().outbox.messages,
        /** Error lines shown to the user. */
        errors: () => [...w.errors],

        /** Lets what is in flight finish. */
        settle: (ms = 30) => sleep(ms),
        /** Lets promises and timers that are already due run. */
        tick,
        until,
    };
}
