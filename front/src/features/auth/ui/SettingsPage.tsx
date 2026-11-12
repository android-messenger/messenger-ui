import {type FormEvent, useEffect, useState} from "react";
import {useNavigate, useSearchParams} from "react-router-dom";
import {useTranslation} from "react-i18next";
import type {SettingsFlow} from "@ory/client";
import type {AxiosError} from "axios";
import {csrfOf, extractFieldErrors, getSettingsFlow, submitSettingsPassword} from "@/features/auth/model/services/kratosFlows.ts";
import {AuthCard, Field, FlowMessages, SubmitButton} from "./AuthCard.tsx";

/**
 * New password after recovery (Kratos settings flow, `?flow=` from the recovery redirect). The
 * recovery code already signed the user in; the privileged window is 15 min (privileged_session_max_age).
 */
export default function SettingsPage() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const [flow, setFlow] = useState<SettingsFlow | null>(null);
    const [busy, setBusy] = useState(false);
    const id = params.get("flow");
    const [failed, setFailed] = useState(!id);

    useEffect(() => {
        if (id) getSettingsFlow(id).then(setFlow, () => setFailed(true));
    }, [id]);

    async function onSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!flow || busy) return;
        const password = String(new FormData(e.currentTarget).get("password") ?? "");
        setBusy(true);
        try {
            await submitSettingsPassword(flow.id, password, csrfOf(flow));
            navigate("/", {replace: true});
        } catch (err) {
            const ax = err as AxiosError<SettingsFlow>;
            if (ax.response?.data?.ui) setFlow(ax.response.data);
            else setFailed(true);   // expired privileged session (403) / no session (401): start over
        } finally {
            setBusy(false);
        }
    }

    if (failed) {
        return (
            <AuthCard title={t("auth.newPasswordTitle")} onSubmit={(e) => { e.preventDefault(); navigate("/recovery", {replace: true}); }}>
                <p className="mb-4 text-sm text-gray-700">{t("auth.recoveryExpired")}</p>
                <SubmitButton busy={false} label={t("auth.recoveryTitle")} busyLabel=""/>
            </AuthCard>
        );
    }
    if (!flow) return <div className="p-6">{t("common.loading")}</div>;

    return (
        <AuthCard title={t("auth.newPasswordTitle")} onSubmit={onSubmit}>
            <FlowMessages messages={flow.ui.messages}/>
            <Field label={t("auth.newPassword")} name="password" type="password" required autoComplete="new-password" autoFocus/>
            {extractFieldErrors(flow, "password").map((m) => <p key={m.id} className="text-red-600 text-sm -mt-2 mb-3">{m.text}</p>)}
            <SubmitButton busy={busy} label={t("auth.savePassword")} busyLabel={t("auth.saving")}/>
        </AuthCard>
    );
}
