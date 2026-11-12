import {memo, useEffect, useRef, useState} from "react";
import {useSelector} from "react-redux";
import {useNavigate} from "react-router-dom";
import {useTranslation} from "react-i18next";

import type {RootState} from "@/store/store";
import type {Contact} from "@/entities/contact";
import i18n, {setLanguage} from "@/shared/i18n";
import {InfoModal} from "@/features/diagnostics/InfoModal.tsx";

// First+last initial for the list avatar (falls back to "?").
const initials = (name: string) => {
    const p = name.trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
};

interface ChatListProps {
    chats: Contact[];
    openChat: (chatId: string) => void;
    unreadChats: Set<string>;
    search: string;
    setSearch: (value: string) => void;
    myName: string;
    onLogout: () => void;
}

function ChatList({
                      chats,
                      openChat,
                      unreadChats,
                      search,
                      setSearch,
                      myName,
                      onLogout,
                  }: ChatListProps) {
    const {t} = useTranslation();
    const lang = i18n.language?.startsWith("en") ? "en" : "es";
    const [infoOpen, setInfoOpen] = useState(false);
    const selectedChatId = useSelector(
        (state: RootState) => state.chatUi.selectedChatId
    );

    const isChatOpen = selectedChatId !== null;

    const navigate = useNavigate();

    // addressing unfocused issue
    const chatListRef = useRef<HTMLDivElement>(null);
    const prevSelectedChatIdRef = useRef<string | null>(selectedChatId);
    useEffect(() => {
        if (prevSelectedChatIdRef.current && selectedChatId === null) {
            chatListRef.current?.focus();
        }
        prevSelectedChatIdRef.current = selectedChatId;
    }, [selectedChatId]);

    return (
        <>
            <aside className={`bg-gray-200 border-r w-full sm:w-1/3 max-w-sm h-full min-h-0
            ${isChatOpen ? "hidden sm:flex" : "flex flex-col"} flex-col`}
            >
                {/* Header */}
                <div className="bg-teal-950 border-b flex-none">
                    <div className="px-4 py-3 flex items-center justify-between text-white">
                        <div className="font-semibold text-lg truncate">{myName}</div>

                        <div className="flex items-center gap-3">
                            {/* Language toggle (persisted) */}
                            <div className="flex items-center text-xs" title={t("language.label")}>
                                <button
                                    onClick={() => setLanguage("es")}
                                    className={`px-1 ${lang === "es" ? "text-white font-semibold" : "text-gray-400 hover:text-gray-200"}`}
                                >
                                    {t("language.es")}
                                </button>
                                <span className="text-gray-500">|</span>
                                <button
                                    onClick={() => setLanguage("en")}
                                    className={`px-1 ${lang === "en" ? "text-white font-semibold" : "text-gray-400 hover:text-gray-200"}`}
                                >
                                    {t("language.en")}
                                </button>
                            </div>

                            <button
                                onClick={() => setInfoOpen(true)}
                                className="text-base opacity-80 hover:opacity-100"
                                title={t("info.openInfo")}
                                aria-label={t("info.openInfo")}
                            >
                                ℹ️
                            </button>

                            <button
                                onClick={onLogout}
                                className="text-sm text-red-400 opacity-100 hover:opacity-90"
                                title={t("chat.logout")}
                                aria-label={t("chat.logout")}
                            >
                                {t("chat.logout")}
                            </button>
                        </div>
                    </div>

                    {/* Search + Add button */}
                    <div className="px-4 pb-3 flex items-center gap-2">
                        <button
                            onClick={() => navigate("/add")}
                            title={t("chat.addContact")}
                            aria-label={t("chat.addContact")}
                            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full
                            bg-teal-950 border-2 text-white
                            border-l-gray-300 border-t-gray-200 border-r-gray-400 border-b-gray-500
                            opacity-100 hover:opacity-85"
                        >
                            +
                        </button>
                        <button
                            onClick={() => navigate("/new-group")}
                            title={t("group.newGroup")}
                            aria-label={t("group.newGroup")}
                            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full
                            bg-teal-950 border-2 text-white
                            border-l-gray-300 border-t-gray-200 border-r-gray-400 border-b-gray-500
                            opacity-100 hover:opacity-85"
                        >
                            👥
                        </button>
                        <input
                            type="text"
                            placeholder={t("chat.searchContact")}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="flex-1 min-w-0 rounded-full px-4 py-2 text-base bg-white border focus:outline-none"
                        />
                    </div>
                </div>

                {/* Chat list */}
                <div
                    className="flex-1 overflow-y-auto pb-6 scrollable-touch"
                    style={{WebkitOverflowScrolling: "touch", overscrollBehavior: "contain"}}
                    ref={chatListRef}
                >
                    {chats.map((chat) => {
                        const isUnread = unreadChats?.has(chat.id);

                        return (
                            <div
                                key={chat.id}
                                onClick={() => openChat(chat.id)}
                                className={`p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-100
                                ${selectedChatId === chat.id ? "bg-gray-100" : ""}`}
                            >
                                {/* Avatar: group icon (no presence — a group has no single peer) or
                                    initials + online dot for a 1:1 peer. */}
                                <span className="relative shrink-0">
                                    <span className="w-10 h-10 rounded-full bg-teal-950 text-white text-sm flex items-center justify-center">
                                        {chat.kind === "group" ? "👥" : initials(chat.name)}
                                    </span>
                                    {chat.kind !== "group" && (
                                        <span
                                            className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-gray-200 ${chat.online ? "bg-green-500" : "bg-gray-400"}`}
                                            title={chat.online ? t("chat.online") : t("chat.offline")}
                                        />
                                    )}
                                </span>

                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        {isUnread && <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0"/>}
                                        <span className={`truncate ${isUnread ? "font-semibold text-gray-900" : "font-medium text-gray-800"}`}>
                                            {chat.name}
                                        </span>
                                    </div>
                                    <div className={`text-sm truncate ${isUnread ? "text-gray-900" : "text-gray-500"}`}>
                                        {chat.kind === "group" ? t("chat.groupChat") : chat.email}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </aside>
            {infoOpen && <InfoModal onClose={() => setInfoOpen(false)}/>}
        </>
    );
}

// Memoized: presence ticks and typing in the chat window re-render <Messenger>, but with stable
// props (memoized callbacks in useChat + Messenger) the sidebar list no longer re-renders with them.
export default memo(ChatList);
