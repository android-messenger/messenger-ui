import {type FormEvent, useCallback, useState} from "react";
import {Link, useNavigate, useSearchParams} from "react-router-dom";
import {useTranslation} from "react-i18next";
import type {RecoveryFlow} from "@ory/client";
import type {AxiosError} from "axios";
import {csrfOf, getRecoveryFlow, initRecoveryFlow, redirectFlowId, submitRecoveryFlow} from "@/features/auth/model/services/kratosFlows.ts";
import useNoSessionFlow from "@/features/auth/hooks/useNoSessionFlow.ts";
import {AuthCard, Field, FlowMessages, SubmitButton} from "./AuthCard.tsx";

/**
 * Forgotten password (Kratos `recovery`, `use: code`): email → code from the mail → Kratos signs the
 * user in and hands over a settings flow, where the new password is set (/settings?flow=).
 */
export default function RecoveryPage() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const id = params.get("flow");
    const init = useCallback(() => (id ? getRecoveryFlow(id).catch(() => initRecoveryFlow()) : initRecoveryFlow()), [id]);
    const [flow, setFlow] = useNoSessionFlow(init, navigate);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!flow || busy) return;
        const f = new FormData(e.currentTarget);
        const body = flow.state === "choose_method" ? {email: String(f.get("email") ?? "")} : {code: String(f.get("code") ?? "")};
        setBusy(true);
        try {
            setFlow(await submitRecoveryFlow(flow.id, {...body, csrf_token: csrfOf(flow)}));
        } catch (err) {
            const next = redirectFlowId(err);
            if (next?.page === "settings") {
                navigate(`/settings?flow=${encodeURIComponent(next.flow)}`, {replace: true});
                return;
            }
            const ax = err as AxiosError<RecoveryFlow>;
            if (ax.response?.status === 410 || ax.response?.status === 403) setFlow(await initRecoveryFlow());
            else if (ax.response?.data?.ui) setFlow(ax.response.data);
        } finally {
            setBusy(false);
        }
    }

    if (!flow) return <div className="p-6">{t("common.loading")}</div>;

    return (
        <AuthCard title={t("auth.recoveryTitle")} onSubmit={onSubmit}>
            <FlowMessages messages={flow.ui.messages}/>
            {flow.state === "choose_method" ? (
                <>
                    <p className="mb-3 text-sm text-gray-600">{t("auth.recoveryAskEmail")}</p>
                    <Field label={t("auth.email")} name="email" type="email" required autoComplete="email" autoFocus/>
                    <SubmitButton busy={busy} label={t("auth.sendCode")} busyLabel={t("auth.sending")}/>
                </>
            ) : (
                <>
                    <Field label={t("auth.code")} name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus/>
                    <SubmitButton busy={busy} label={t("auth.confirm")} busyLabel={t("auth.checking")}/>
                </>
            )}
            <p className="mt-4 text-center text-sm text-gray-600">
                <Link to="/login" className="text-teal-950 hover:underline">{t("auth.backToLogin")}</Link>
            </p>
        </AuthCard>
    );
}
