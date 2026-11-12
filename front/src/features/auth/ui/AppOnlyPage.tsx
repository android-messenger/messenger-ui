import {useEffect, useRef, useState} from "react";
import {useDispatch} from "react-redux";
import {useTranslation} from "react-i18next";
import type {AppDispatch} from "@/store/store.ts";
import {fullLogout, goLoginAfterLogout} from "@/features/auth/model/services/fullLogout.ts";

/**
 * D17: this account is registered in the Android app and may not use the browser. Logs out on arrival
 * (push subscription first, S1 §6), then explains and offers another account.
 */
export default function AppOnlyPage() {
    const {t} = useTranslation();
    const dispatch = useDispatch<AppDispatch>();
    const [done, setDone] = useState(false);
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        fullLogout(dispatch).finally(() => setDone(true));
    }, [dispatch]);

    return (
        <div className="min-h-dvh flex items-center justify-center bg-gray-200 p-4">
            <div className="bg-white p-6 rounded-xl shadow w-96 max-w-full text-center">
                <div className="text-4xl mb-3">📱</div>
                <h1 className="text-xl font-semibold mb-3">{t("auth.appOnlyTitle")}</h1>
                <p className="text-gray-600 mb-6">{t("auth.appOnlyText")}</p>
                <button
                    onClick={goLoginAfterLogout}
                    disabled={!done}
                    className="w-full py-2 rounded text-white bg-teal-950 hover:bg-teal-900 disabled:bg-gray-400"
                >
                    {done ? t("auth.appOnlyOtherAccount") : t("auth.loggingOut")}
                </button>
            </div>
        </div>
    );
}
