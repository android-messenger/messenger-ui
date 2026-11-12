import {useState} from "react";
import {useTranslation} from "react-i18next";
import type {Contact} from "@/entities/contact";
import {PhoneIcon, VideoIcon, KeyIcon, FingerprintIcon} from "@/shared/ui/icons.tsx";

/**
 * Chat window header: counterpart name + presence line (typing / online / last-seen / offline) and
 * the call / block / delete actions. Presentational — no scroll or read-receipt state — extracted
 * from ChatWindow. Behavior preserved verbatim.
 */
export function ChatHeader({
    chat,
    isGroup,
    memberCount,
    onlineCount,
    typingName,
    onOpenRoster,
    peerTyping,
    lastSeenText,
    blockedByMe,
    onBack,
    onCall,
    onAudioCall,
    onToggleBlock,
    onDeleteChat,
    secret,
    onToggleSecret,
    onOpenSafety,
}: {
    chat: Contact | null;
    isGroup?: boolean;
    memberCount?: number;
    onlineCount?: number;
    typingName?: string;
    onOpenRoster?: () => void;
    peerTyping: boolean;
    lastSeenText: string | null;
    blockedByMe?: boolean;
    onBack: () => void;
    onCall: () => void;
    onAudioCall: () => void;
    onToggleBlock?: () => void;
    onDeleteChat: () => void;
    secret?: boolean;
    onToggleSecret?: () => void;
    onOpenSafety?: () => void;
}) {
    const {t} = useTranslation();
    const [menuOpen, setMenuOpen] = useState(false);
    return (
        <div
            className="shrink-0 py-2.5 px-3 bg-teal-950 text-white border-b font-semibold flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
                <button
                    onClick={onBack}
                    className="sm:hidden text-xl"
                    aria-label={t("chat.back")}
                    title={t("chat.back")}
                >
                    ←
                </button>
                {/* In a group the name+subtitle open the roster panel (members / add / leave). */}
                <span
                    className={`flex flex-col leading-tight min-w-0 ${isGroup ? "cursor-pointer" : ""}`}
                    onClick={isGroup ? onOpenRoster : undefined}
                >
                    <span className="truncate">{isGroup ? `👥 ${chat?.name}` : chat?.name}</span>
                    <span className="text-xs font-normal truncate">
                        {isGroup
                            ? peerTyping
                                ? <span className="text-teal-300">{typingName ? t("group.typingBy", {name: typingName}) : t("chat.typing")}</span>
                                : <span className="text-gray-400">{t("group.membersOnline", {n: memberCount ?? 0, online: onlineCount ?? 0})}</span>
                            : peerTyping
                                ? <span className="text-teal-300">{t("chat.typing")}</span>
                                : chat?.online
                                    ? <span className="text-green-400">● {t("chat.online")}</span>
                                    : <span className="text-gray-400">● {lastSeenText ? t("chat.lastSeen", {time: lastSeenText}) : t("chat.offline")}</span>}
                    </span>
                </span>
            </div>

            <div className="flex items-center gap-1 shrink-0 text-white">
                {isGroup && (
                    <button onClick={onOpenRoster} title={t("group.members")} aria-label={t("group.members")} className="hover:opacity-80 text-lg p-1">ⓘ</button>
                )}

                {/* Secret chat: the key turns the mode on (struck key) and off (whole key). Verify
                    (fingerprint) only when on. */}
                {!isGroup && !secret && onToggleSecret && (
                    <button
                        onClick={onToggleSecret}
                        title={t("chat.secretEnableTitle")}
                        aria-label={t("chat.secretEnableTitle")}
                        className="p-1 transition-opacity opacity-55 hover:opacity-80"
                    >
                        <KeyIcon width={17} height={17} struck/>
                    </button>
                )}
                {!isGroup && secret && onToggleSecret && (
                    <button onClick={onToggleSecret} title={t("chat.secretDisableTitle")} aria-label={t("chat.secretDisableTitle")} className="p-1 hover:opacity-80">
                        <KeyIcon width={17} height={17} struck={false}/>
                    </button>
                )}
                {!isGroup && secret && !onToggleSecret && (
                    <span className="p-1" role="img" title={t("chat.secretOn")} aria-label={t("chat.secretOn")}>
                        <KeyIcon width={17} height={17} struck={false}/>
                    </span>
                )}
                {!isGroup && secret && onOpenSafety && (
                    <button onClick={onOpenSafety} title={t("chat.safetyVerifyTitle")} aria-label={t("chat.safetyVerifyTitle")} className="p-1 hover:opacity-80">
                        <FingerprintIcon width={17} height={17}/>
                    </button>
                )}

                {!isGroup && (
                    <button onClick={onAudioCall} title={t("chat.audioCall")} aria-label={t("chat.audioCall")} className="hover:opacity-80 p-1">
                        <PhoneIcon width={18} height={18}/>
                    </button>
                )}
                {!isGroup && (
                    <button onClick={onCall} title={t("chat.call")} aria-label={t("chat.call")} className="hover:opacity-80 p-1">
                        <VideoIcon width={18} height={18}/>
                    </button>
                )}

                {/* Secondary/destructive actions (block, delete) tucked into a ⋯ menu so they don't crowd
                    the header or push out the name. Group's terminal action is "leave" (in the roster). */}
                {!isGroup && (
                    <div className="relative">
                        <button onClick={() => setMenuOpen((v) => !v)} title={t("chat.moreActions")} aria-label={t("chat.moreActions")}
                                aria-haspopup="menu" aria-expanded={menuOpen} className="hover:opacity-80 p-1 text-lg leading-none">⋯</button>
                        {menuOpen && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)}/>
                                <div className="absolute right-0 mt-1 z-50 bg-white text-teal-950 rounded-lg shadow-lg py-1 min-w-[140px] text-sm font-normal">
                                    <button onClick={() => { setMenuOpen(false); onToggleBlock?.(); }} className="w-full text-left px-3 py-2 hover:bg-teal-50">
                                        {blockedByMe ? t("chat.unblock") : t("chat.block")}
                                    </button>
                                    <button onClick={() => { setMenuOpen(false); onDeleteChat(); }} className="w-full text-left px-3 py-2 text-red-600 hover:bg-red-50">
                                        {t("chat.deleteChat")}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
