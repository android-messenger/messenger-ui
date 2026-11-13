import {useEffect, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {useTranslation} from "react-i18next";
import type {AppDispatch, RootState} from "@/store/store";
import {appVersion, buildTime, getLoginAt, connectsInLast, connectBuckets} from "@/shared/diag/diag.ts";
import {mediaStats} from "@/features/chat/db/db.ts";
import {cryptoStats, type CryptoStats} from "@/features/e2ee";
import {wipeAllStorage} from "./wipeStorage.ts";
import {canInstall, isStandalone, promptInstall} from "@/shared/pwa/installPrompt.ts";
import {appSettings, deviceTrust, isNativeApp} from "@/shared/platform.ts";
import {fullLogout, goLoginAfterLogout} from "@/features/auth/model/services/fullLogout.ts";

// Diagnostics / info page (modal): app identity, storage usage, encryption state, connection health.
// All numbers are read on open. The one action is "erase everything": it signs out and erases the device.

/** What the Android app tells about itself: the APK version, the device certificate, where the keys are kept. */
interface AppInfo { version?: string; certState?: string; certUntil?: number; keyStore?: string; patch?: string }

async function readAppInfo(): Promise<AppInfo> {
    const info: AppInfo = {};
    try {
        const v = await appSettings().getAppInfo?.();
        if (v) info.version = `${v.versionName} (${v.versionCode})`;
    } catch { /* an older APK: the version of the interface is shown instead */ }
    try {
        const s = await deviceTrust().getState();
        info.certState = s.state;
        if (s.notAfter) info.certUntil = Date.parse(s.notAfter) || undefined;
    } catch { /* not shown */ }
    try {
        const d = await deviceTrust().getDeviceInfo();
        info.keyStore = d.securityLevel ?? (d.strongBox ? "StrongBox" : undefined);
        info.patch = d.securityPatch;
    } catch { /* not shown */ }
    return info;
}

function fmtBytes(n: number): string {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtWhen(ms: number, locale: string): string {
    return ms ? new Date(ms).toLocaleString(locale, {dateStyle: "medium", timeStyle: "short"}) : "—";
}

function Row({label, value, mono}: {label: string; value: string | number; mono?: boolean}) {
    return (
        <div className="flex justify-between gap-3 py-1.5 text-sm border-b border-teal-50 last:border-0">
            <span className="text-teal-700">{label}</span>
            <span className={`text-teal-950 text-right ${mono ? "font-mono text-[13px]" : ""}`}>{value}</span>
        </div>
    );
}
// Tiny bar sparkline (reconnect activity over time), endpoint emphasized.
function Sparkline({data}: {data: number[]}) {
    const max = Math.max(1, ...data);
    const w = 5;
    return (
        <svg viewBox={`0 0 ${data.length * w} 22`} preserveAspectRatio="none" className="w-full h-6" aria-hidden>
            {data.map((v, i) => {
                const h = (v / max) * 20;
                return <rect key={i} x={i * w} y={22 - h} width={w - 1.4} height={Math.max(v ? 1.5 : 0, h)} rx={0.8}
                             className={i === data.length - 1 ? "fill-teal-700" : "fill-teal-400"}/>;
            })}
        </svg>
    );
}

// Stacked storage breakdown by category.
function StackedBar({segs, total}: {segs: {label: string; bytes: number; cls: string}[]; total: number}) {
    const t = Math.max(1, total);
    return (
        <div className="py-2">
            <div className="h-2.5 rounded-full overflow-hidden flex bg-teal-100">
                {segs.map((s) => s.bytes > 0 && (
                    <div key={s.label} className={s.cls} style={{width: `${(s.bytes / t) * 100}%`}} title={s.label}/>
                ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-teal-700">
                {segs.map((s) => (
                    <span key={s.label} className="inline-flex items-center gap-1">
                        <span className={`inline-block w-2 h-2 rounded-sm ${s.cls}`}/>{s.label}
                    </span>
                ))}
            </div>
        </div>
    );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
    return (
        <div className="mb-4">
            <h4 className="text-[11px] font-semibold tracking-wide uppercase text-teal-500 mb-1">{title}</h4>
            <div className="bg-teal-50/60 rounded-lg px-3 py-1">{children}</div>
        </div>
    );
}

export function InfoModal({onClose}: {onClose: () => void}) {
    const {t, i18n} = useTranslation();
    const locale = i18n.language || "en";
    const dispatch = useDispatch<AppDispatch>();
    const inApp = isNativeApp();
    const [app, setApp] = useState<AppInfo>({});
    const userId = useSelector((s: RootState) => s.user.id);
    const wsStatus = useSelector((s: RootState) => s.ws?.status ?? "—");

    const [store, setStore] = useState<{usage: number; quota: number; persisted: boolean} | null>(null);
    const [media, setMedia] = useState<{files: number; fileBytes: number; chats: number; messages: number} | null>(null);
    const [crypto, setCrypto] = useState<CryptoStats | null>(null);
    const [confirmWipe, setConfirmWipe] = useState(false);
    const [wiping, setWiping] = useState(false);
    // Install affordance, read once on open (the beforeinstallprompt event is captured at boot).
    const [installed] = useState(isStandalone);
    const [installable, setInstallable] = useState(canInstall);

    const doInstall = async () => { await promptInstall(); setInstallable(canInstall()); };
    const doWipe = async () => {
        setWiping(true);
        // Sign out first: the push registration, the keys in the Android app's library, its record in the key
        // directory and the session go too — erasing the interface's storage alone would leave all of them.
        await fullLogout(dispatch);
        await wipeAllStorage();
        goLoginAfterLogout();   // a full page load: nothing stays in memory
    };

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const est = (await navigator.storage?.estimate?.()) ?? {};
                const persisted = (await navigator.storage?.persisted?.()) ?? false;
                if (alive) setStore({usage: est.usage ?? 0, quota: est.quota ?? 0, persisted});
            } catch { /* ignore */ }
            void mediaStats().then((m) => alive && setMedia(m));
            void cryptoStats().then((c) => alive && setCrypto(c));
            if (inApp) void readAppInfo().then((a) => alive && setApp(a));
        })();
        return () => { alive = false; };
    }, [inApp]);

    const usagePct = store && store.quota ? Math.min(100, (store.usage / store.quota) * 100) : 0;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 safe-area-pad-4" onClick={onClose}>
            <div className="bg-white text-teal-950 rounded-xl max-w-md w-full max-h-[85vh] overflow-y-auto p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold mb-4">ℹ️ {t("info.title")}</h3>

                <Section title={t("info.general")}>
                    {/* In the app the version is the APK's; the interface inside it has only its build time. */}
                    <Row label={t("info.version")} value={inApp ? (app.version ?? "…") : `${appVersion}`} mono/>
                    <Row label={t(inApp ? "info.uiBuild" : "info.build")} value={fmtWhen(buildTime ? Date.parse(buildTime) : 0, locale)}/>
                    <Row label={t("info.loginAt")} value={fmtWhen(getLoginAt(), locale)}/>
                    <Row label={t("info.userId")} value={userId ? userId.slice(0, 8) + "…" : "—"} mono/>
                    <Row label={t("info.locale")} value={locale}/>
                </Section>

                {inApp && (
                    <Section title={t("info.device")}>
                        <Row label={t("info.certState")} value={app.certState ?? "…"} mono/>
                        <Row label={t("info.certUntil")} value={fmtWhen(app.certUntil ?? 0, locale)}/>
                        <Row label={t("info.keyStore")} value={app.keyStore ?? "—"} mono/>
                        <Row label={t("info.securityPatch")} value={app.patch ?? "—"} mono/>
                    </Section>
                )}

                <Section title={t("info.storage")}>
                    <div className="flex justify-between text-sm pt-1"><span className="text-teal-700">{t("info.used")}</span>
                        <span className="text-teal-950">{store ? `${fmtBytes(store.usage)} / ${fmtBytes(store.quota)} (${usagePct.toFixed(0)}%)` : "…"}</span></div>
                    <StackedBar total={store?.usage ?? 0} segs={[
                        {label: t("info.files"), bytes: media?.fileBytes ?? 0, cls: "bg-teal-600"},
                        {label: t("info.secretMsgs"), bytes: crypto?.secretBytes ?? 0, cls: "bg-amber-500"},
                        {label: t("info.other"), bytes: Math.max(0, (store?.usage ?? 0) - (media?.fileBytes ?? 0) - (crypto?.secretBytes ?? 0)), cls: "bg-teal-300"},
                    ]}/>
                    <Row label={t("info.persisted")} value={store ? (store.persisted ? "✓" : "✕") : "…"}/>
                    <Row label={t("info.files")} value={media ? `${media.files} · ${fmtBytes(media.fileBytes)}` : "…"}/>
                    <Row label={t("info.messages")} value={media ? `${media.messages} · ${media.chats} ${t("info.chats")}` : "…"}/>
                </Section>

                <Section title={t("info.encryption")}>
                    <Row label={t("info.secretMsgs")} value={crypto ? `${crypto.secretMessages} · ${fmtBytes(crypto.secretBytes)}` : "…"}/>
                    <Row label={t("info.pending")} value={crypto ? crypto.pendingRecovery : "…"}/>
                    <Row label={t("info.protocol")} value={crypto?.protocol ?? "…"} mono/>
                </Section>

                <Section title={t("info.connection")}>
                    <Row label={t("info.wsStatus")} value={wsStatus}/>
                    <Row label={t("info.reconnects")} value={connectsInLast(10 * 60 * 1000)}/>
                    <div className="py-1.5">
                        <div className="text-[11px] text-teal-600 mb-1">{t("info.reconnects20")}</div>
                        <Sparkline data={connectBuckets(20 * 60 * 1000, 20)}/>
                    </div>
                </Section>

                {!inApp && <Section title={t("info.install")}>
                    {installed ? (
                        <div className="py-1.5 text-sm text-teal-700">✓ {t("info.installed")}</div>
                    ) : installable ? (
                        <button onClick={doInstall}
                                className="w-full my-1 py-2 rounded-lg bg-teal-700 text-white text-sm font-medium hover:bg-teal-800">
                            {t("info.installBtn")}
                        </button>
                    ) : (
                        <div className="py-1.5 text-[13px] text-teal-700 leading-relaxed">
                            <div>{t("info.installHintIos")}</div>
                            <div>{t("info.installHintOther")}</div>
                        </div>
                    )}
                </Section>}

                <Section title={t("info.dangerZone")}>
                    {!confirmWipe ? (
                        <button onClick={() => setConfirmWipe(true)}
                                className="w-full my-1 py-2 rounded-lg border border-red-300 text-red-700 text-sm font-medium hover:bg-red-50">
                            {t("info.wipe")}
                        </button>
                    ) : (
                        <div className="my-1">
                            <p className="text-[13px] text-red-700 leading-relaxed mb-2">{t("info.wipeDesc")}</p>
                            <div className="flex gap-2">
                                <button onClick={doWipe} disabled={wiping}
                                        className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60">
                                    {wiping ? t("info.wiping") : t("info.wipeConfirm")}
                                </button>
                                <button onClick={() => setConfirmWipe(false)} disabled={wiping}
                                        className="flex-1 py-2 rounded-lg bg-teal-100 text-teal-800 text-sm font-medium hover:bg-teal-200 disabled:opacity-60">
                                    {t("info.cancel")}
                                </button>
                            </div>
                        </div>
                    )}
                </Section>

                <button onClick={onClose} className="w-full mt-1 py-2 text-teal-700 text-sm hover:underline">{t("info.close")}</button>
            </div>
        </div>
    );
}
