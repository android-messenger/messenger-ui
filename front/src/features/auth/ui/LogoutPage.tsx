import {useNavigate} from "react-router-dom";
import {useDispatch} from "react-redux";
import {useTranslation} from "react-i18next";
import type {AppDispatch} from "@/store/store.ts";
import {useState} from "react";
import {fullLogout, goLoginAfterLogout} from "@/features/auth/model/services/fullLogout.ts";
import {logger} from "@/shared/logger/logger.ts";


export default function LogoutPage() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const dispatch = useDispatch<AppDispatch>();
    const [loading, setLoading] = useState(false);

    const handleLogout = async () => {
        setLoading(true);
        try {
            await fullLogout(dispatch);
        } catch (err) {
            logger.error("Logout error", err as Error);
        } finally {
            setLoading(false);
        }
        // Even if a step failed, send the user to login rather than leaving them stuck. A full page
        // load, not a router navigation: nothing of the previous account stays in memory.
        goLoginAfterLogout();
    };

    const handleCancel = () => {
        navigate(-1);
    };

    return (
        <div className="min-h-dvh flex items-center justify-center bg-gray-200">
            <div className="bg-white p-6 rounded-xl shadow w-80 text-center">
                <h1 className="text-xl font-semibold mb-4">{t("auth.logoutTitle")}</h1>
                <p className="text-gray-600 mb-6">{t("auth.logoutConfirm")}</p>

                <div className="flex gap-3">
                    <button
                        onClick={handleCancel}
                        className="w-full border py-2 rounded hover:bg-gray-100"
                        disabled={loading}
                    >
                        {t("common.cancel")}
                    </button>

                    <button
                        onClick={handleLogout}
                        className="w-full bg-red-600 text-white py-2 rounded hover:bg-red-700"
                        disabled={loading}
                    >
                        {loading ? t("auth.loggingOut") : t("auth.logout")}
                    </button>
                </div>
            </div>
        </div>
    );
}
