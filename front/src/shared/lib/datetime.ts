// Pure, framework-agnostic date/time helpers shared across features. These render in the VIEWER's
// own locale + timezone (the browser Intl defaults) — no business rules here, just formatting.

/** True when two epoch-millis instants fall on the same local calendar day. */
export const sameDay = (a: number, b: number): boolean => {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

/** Local HH:mm for an epoch-millis instant (e.g. "14:05"). */
export const formatLocalTime = (ms: number): string =>
    new Date(ms).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});

/** Local short date for an epoch-millis instant; the year is omitted when it equals `now`'s year. */
export const formatLocalDate = (ms: number, now: number = Date.now()): string => {
    const d = new Date(ms);
    return d.toLocaleDateString([], {
        day: "2-digit",
        month: "short",
        year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
    });
};
