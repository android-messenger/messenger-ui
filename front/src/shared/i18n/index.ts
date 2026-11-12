import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import es from "./es/translation.json";
import en from "./en/translation.json";
import {reportNativeLanguage} from "@/infrastructure/native/nativeLanguage.ts";

export const LANG_STORAGE_KEY = "messenger.lang";
const SUPPORTED = ["es", "en"] as const;

function initialLang(): string {
    try {
        const saved = localStorage.getItem(LANG_STORAGE_KEY);
        if (saved && (SUPPORTED as readonly string[]).includes(saved)) return saved;
    } catch { /* localStorage unavailable → fall through */ }
    return "es";
}

// Android app: native texts follow the UI language (S1 §5.5). Subscribed before init, which sets the first one.
i18n.on("languageChanged", reportNativeLanguage);

i18n
    .use(initReactI18next)
    .init({
        resources: {
            en: { translation: en },
            es: { translation: es }
        },
        lng: initialLang(),
        fallbackLng: "en",
        interpolation: {
            escapeValue: false
        }
    });

/** Switch language and persist the choice. */
export function setLanguage(lng: string) {
    i18n.changeLanguage(lng);
    try { localStorage.setItem(LANG_STORAGE_KEY, lng); } catch { /* ignore */ }
}

export default i18n;
