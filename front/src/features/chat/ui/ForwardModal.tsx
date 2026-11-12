import {useState} from "react";
import {useTranslation} from "react-i18next";
import type {Contact} from "@/entities/contact";

/**
 * Forward picker: choose a chat to forward a message's text into. Presentational — the actual send is
 * done by the caller's `onPick(chatId)` (which enqueues the text into that conversation). Text only;
 * attachments are not forwarded (they'd need re-upload/re-encryption).
 *
 * Secrecy guard: when the source message comes from a SECRET (E2EE) chat, forwarding into a non-secret
 * chat would send the text to the server in cleartext. We never do that silently — secret targets are
 * marked 🔒, and picking a non-secret target requires an explicit downgrade confirmation.
 */
export function ForwardModal({
    chats,
    preview,
    sourceSecret,
    isSecretTarget,
    onPick,
    onClose,
}: {
    chats: Contact[];
    preview: string;
    sourceSecret?: boolean;
    isSecretTarget?: (chatId: string) => boolean;
    onPick: (chatId: string) => void;
    onClose: () => void;
}) {
    const {t} = useTranslation();
    const [q, setQ] = useState("");
    const [confirm, setConfirm] = useState<Contact | null>(null);   // a non-secret target awaiting downgrade confirm
    const filtered = q.trim()
        ? chats.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))
        : chats;

    const choose = (c: Contact) => {
        // Downgrade guard: secret source → non-secret target needs confirmation; otherwise pick directly.
        if (sourceSecret && isSecretTarget && !isSecretTarget(c.id)) { setConfirm(c); return; }
        onPick(c.id);
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 safe-area-pad-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label={t("chat.forwardTo", {defaultValue: "Forward to…"})}
        >
            <div
                className="w-full max-w-sm max-h-[80vh] flex flex-col overflow-hidden rounded-xl bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-4 py-3 border-b border-gray-200">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-teal-950">{t("chat.forwardTo", {defaultValue: "Forward to…"})}</h2>
                        <button onClick={onClose} aria-label={t("close", {defaultValue: "Close"})}
                                className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
                    </div>
                    <p className="mt-1 truncate text-xs text-gray-500" title={preview}>“{preview}”</p>
                    {/* text-base (16px): a smaller font makes mobile browsers auto-zoom on focus, which
                        blew the dialog off-screen (same bug fixed in the group roster panel). */}
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder={t("chat.searchPlaceholder", {defaultValue: "Search"})}
                        className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-base focus:border-teal-600 focus:outline-none"
                    />
                </div>

                {confirm ? (
                    // Downgrade confirmation: secret message's text would be sent unencrypted to this chat.
                    <div className="px-4 py-5">
                        <p className="text-sm text-teal-950">
                            {t("chat.forwardSecretWarning", {
                                defaultValue: "This message is from a secret chat. Forwarding it to {{name}} will send its text unencrypted.",
                                name: confirm.name,
                            })}
                        </p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button onClick={() => setConfirm(null)}
                                    className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
                                {t("cancel", {defaultValue: "Cancel"})}
                            </button>
                            <button onClick={() => onPick(confirm.id)}
                                    className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">
                                {t("chat.forwardAnyway", {defaultValue: "Forward unencrypted"})}
                            </button>
                        </div>
                    </div>
                ) : (
                    <ul className="flex-1 overflow-y-auto">
                        {filtered.length === 0 && (
                            <li className="px-4 py-6 text-center text-sm text-gray-400">{t("chat.noChats", {defaultValue: "No chats"})}</li>
                        )}
                        {filtered.map((c) => {
                            const targetSecret = !!isSecretTarget?.(c.id);
                            return (
                                <li key={c.id}>
                                    <button
                                        onClick={() => choose(c)}
                                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-100"
                                    >
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-900 text-xs font-semibold text-white">
                                            {c.kind === "group" ? "👥" : c.name.slice(0, 2).toUpperCase()}
                                        </span>
                                        <span className="flex-1 truncate text-sm text-teal-950">{c.name}</span>
                                        {targetSecret && <span className="text-xs opacity-60" title={t("chat.secretOn")}>🔒</span>}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
