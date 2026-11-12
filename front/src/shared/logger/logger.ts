type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const CURRENT_LEVEL: LogLevel =
    (import.meta.env.VITE_LOG_LEVEL as LogLevel) ??
    (import.meta.env.PROD ? "info" : "debug");

console.log("Current log LEVEL ", CURRENT_LEVEL);

function shouldLog(level: LogLevel) {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[CURRENT_LEVEL];
}

function log(
    level: LogLevel,
    message: string,
    meta?: unknown
) {
    if (!shouldLog(level)) return;

    const payload = meta && true ? JSON.stringify(meta) : " ";
    const prefix = `[${level.toUpperCase()}] ${message}`;

    switch (level) {
        case "debug":
            console.debug(prefix, payload);
            break;
        case "info":
            console.info(prefix, payload);
            break;
        case "warn":
            console.warn(prefix, payload);
            break;
        case "error":
            console.error(prefix, payload);
            break;
    }
}

export const logger = {
    debug: (msg: string, meta?: unknown) =>
        log("debug", msg, meta),
    info: (msg: string, meta?: unknown) =>
        log("info", msg, meta),
    warn: (msg: string, meta?: unknown) =>
        log("warn", msg, meta),
    error: (msg: string, meta?: unknown) =>
        log("error", msg, meta),
};
