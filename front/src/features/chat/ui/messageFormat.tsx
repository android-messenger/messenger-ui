import {Fragment} from "react";
import {sameDay, formatLocalDate} from "@/shared/lib/datetime.ts";

// Presentation helpers for rendering messages in the chat window (pure, no state).

// Render message text with clickable links. Safe: builds React nodes (no HTML injection).
const URL_RE = /(https?:\/\/[^\s]+)/g;
export function linkify(text: string) {
    return text.split(URL_RE).map((part, i) =>
        /^https?:\/\//.test(part)
            ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline break-all">{part}</a>
            : <Fragment key={i}>{part}</Fragment>
    );
}

// "Hoy" / "Ayer" / a localized date for the day-separator chips.
export function dateLabel(ms: number, t: (k: string) => string) {
    const now = Date.now();
    if (sameDay(ms, now)) return t("chat.today");
    if (sameDay(ms, now - 86_400_000)) return t("chat.yesterday");
    return formatLocalDate(ms, now);
}
