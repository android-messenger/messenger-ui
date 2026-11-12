import {type FormEvent, useEffect, useRef, useState} from "react";
import {Link, useSearchParams} from "react-router-dom";
import {useTranslation} from "react-i18next";
import type {VerificationFlow} from "@ory/client";
import type {AxiosError} from "axios";
import {csrfOf, getVerificationFlow, initVerificationFlow, submitVerificationFlow} from "@/features/auth/model/services/kratosFlows.ts";
import {AuthCard, Field, FlowMessages, SubmitButton} from "./AuthCard.tsx";

/**
 * Email verification with a code (Kratos `verification`, `use: code`). Reached from registration
 * (`?flow=` from continue_with), from the login page (`?email=` after "not verified"), or from the
 * link in the mail (`?flow=&code=` — submitted at once).
 */
export default function VerificationPage() {
    const {t} = useTranslation();
    const [params] = useSearchParams();
    const [flow, setFlow] = useState<VerificationFlow | null>(null);
    const [busy, setBusy] = useState(false);
    const autoSent = useRef(false);

    useEffect(() => {
        const id = params.get("flow");
        (id ? getVerificationFlow(id).catch(() => initVerificationFlow()) : initVerificationFlow()).then(setFlow);
    }, [params]);

    async function send(body: {email?: string; code?: string}) {
        if (!flow || busy) return;
        setBusy(true);
        try {
            setFlow(await submitVerificationFlow(flow.id, {...body, csrf_token: csrfOf(flow)}));
        } catch (err) {
            const e = err as AxiosError<VerificationFlow>;
            if (e.response?.status === 410 || e.response?.status === 403) setFlow(await initVerificationFlow());
            else if (e.response?.data?.ui) setFlow(e.response.data);
        } finally {
            setBusy(false);
        }
    }

    // The link in the mail carries the code: check it without a click (once).
    useEffect(() => {
        const code = params.get("code");
        if (flow && code && flow.state === "sent_email" && !autoSent.current) {
            autoSent.current = true;
            void send({code});
        }
    });

    function onSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void send(flow?.state === "choose_method" ? {email: String(f.get("email") ?? "")} : {code: String(f.get("code") ?? "")});
    }

    if (!flow) return <div className="p-6">{t("common.loading")}</div>;

    if (flow.state === "passed_challenge") {
        return (
            <AuthCard title={t("auth.verifyTitle")} onSubmit={(e) => e.preventDefault()}>
                <p className="mb-4 text-sm text-gray-700">{t("auth.verifyDone")}</p>
                <Link to="/login" className="block text-center w-full py-2 rounded text-white bg-teal-950 hover:bg-teal-900">{t("auth.login")}</Link>
            </AuthCard>
        );
    }

    return (
        <AuthCard title={t("auth.verifyTitle")} onSubmit={onSubmit}>
            <FlowMessages messages={flow.ui.messages}/>
            {flow.state === "choose_method" ? (
                <>
                    <p className="mb-3 text-sm text-gray-600">{t("auth.verifyAskEmail")}</p>
                    <Field label={t("auth.email")} name="email" type="email" required autoComplete="email" autoFocus defaultValue={params.get("email") ?? ""}/>
                    <SubmitButton busy={busy} label={t("auth.sendCode")} busyLabel={t("auth.sending")}/>
                </>
            ) : (
                <>
                    <Field label={t("auth.code")} name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus defaultValue={params.get("code") ?? ""}/>
                    <SubmitButton busy={busy} label={t("auth.confirm")} busyLabel={t("auth.checking")}/>
                </>
            )}
            <p className="mt-4 text-center text-sm text-gray-600">
                <Link to="/login" className="text-teal-950 hover:underline">{t("auth.backToLogin")}</Link>
            </p>
        </AuthCard>
    );
}
