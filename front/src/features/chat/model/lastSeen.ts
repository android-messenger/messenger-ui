// Format a peer's "last seen" moment for the chat header.
//
// The backend sends `lastSeen` as UTC epoch-millis (nullable — null while the peer is online, never
// recorded, or past the retention window). We render it in the VIEWER's own local timezone via the
// browser's Intl (`toLocale*` with `[]` = current locale), matching the message-timestamp helpers.
//
// Shape mirrors dateLabel(): today → just the local time (HH:mm); yesterday → "yesterday HH:mm";
// older → localized date + time. Returns null when there is nothing to show (so the caller falls
// back to a plain "offline").

import {sameDay, formatLocalTime, formatLocalDate} from "@/shared/lib/datetime.ts";

/**
 * @param lastSeen UTC epoch millis, or null/undefined.
 * @param t        i18n translator (for the "today"/"yesterday" words).
 * @param now      injectable clock (epoch ms) — defaults to Date.now(); pass a fixed value in tests.
 * @returns a localized "last seen" phrase, or null when there is nothing to render.
 */
export function fmtLastSeen(
    lastSeen: number | null | undefined,
    t: (k: string) => string,
    now: number = Date.now(),
): string | null {
    if (lastSeen == null) return null;
    if (sameDay(lastSeen, now)) return formatLocalTime(lastSeen);
    if (sameDay(lastSeen, now - 86_400_000)) return `${t("chat.yesterday")} ${formatLocalTime(lastSeen)}`;
    return `${formatLocalDate(lastSeen, now)} ${formatLocalTime(lastSeen)}`;
}
