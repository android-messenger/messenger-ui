import {type FormEvent, useState} from "react";
import {Link, useNavigate} from "react-router-dom";
import {useTranslation} from "react-i18next";
import type {RegistrationFlow, UiNode, UiNodeInputAttributes, UpdateRegistrationFlowBody,} from "@ory/client";
import {
    extractFieldErrors,
    findHiddenNodes,
    findInputNode,
    handleFlowError,
    initRegistrationFlow, isInputNode,
    submitRegistrationFlow,
    verificationFlowId,
} from "@/features/auth/model/services/kratosFlows.ts";
import useNoSessionFlow from "@/features/auth/hooks/useNoSessionFlow.ts";

export default function RegistrationPage() {
    const {t} = useTranslation();
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();
    const [flow, setFlow] = useNoSessionFlow(initRegistrationFlow, navigate);

    async function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!flow || loading) return;

        setLoading(true);

        try {
            const formData = new FormData(e.currentTarget);

            const {data} = await submitRegistrationFlow(flow.id, {
                method: "password",
                csrf_token: formData.get("csrf_token"),
                password: formData.get("password"),
                traits: {
                    email: formData.get("traits.email"),
                    // The platform identity schema models name as an object
                    // {first,last}; sending a scalar => Kratos "expected object".
                    name: {
                        first: formData.get("traits.name.first"),
                        last: formData.get("traits.name.last"),
                    },
                },
            } as UpdateRegistrationFlowBody);

            // No session yet: signing in needs a verified email (Kratos require_verified_address).
            // Kratos has already mailed a code and started the verification flow.
            const vf = verificationFlowId(data);
            navigate(vf ? `/verify?flow=${encodeURIComponent(vf)}` : `/verify?email=${encodeURIComponent(String(formData.get("traits.email") ?? ""))}`, {replace: true});
        } catch (err) {
            handleFlowError(err, initRegistrationFlow, setFlow);
        } finally {
            setLoading(false);
        }
    }

    const PASSWORD_EMPTY_ERROR = 4000002;

    function renderRegistration(
        node: UiNode,
        props: {
            type: string;
            required?: boolean;
            autoComplete?: string;
        },
        flow: RegistrationFlow
    ) {
        if (!isInputNode(node)) return null;
        const attr = node.attributes;
        const errors = extractFieldErrors(flow, attr.name);
        const isPassword = props.type === "password";
        const labelText = isPassword ? t("auth.password") : node.meta?.label?.text;


        return (
            <div key={attr.name} className="mb-3">
                {labelText && (
                    <label className="block text-sm font-medium mb-1">
                        {labelText}
                    </label>
                )}

                <input
                    name={attr.name}
                    type={props.type}
                    required={props.required}
                    autoComplete={props.autoComplete}
                    defaultValue={attr.value ?? ""}
                    className="w-full border rounded px-3 py-2"
                />

                {errors.map((e) => (
                    e.id !== PASSWORD_EMPTY_ERROR && (<p key={e.id} className="text-red-600 text-sm">
                        {e.text}
                    </p>)
                ))}
            </div>
        );
    }

    if (!flow) return <div className="p-6">{t("common.loading")}</div>;

    const hiddenNodes = findHiddenNodes(flow);
    const emailNode = findInputNode(flow, "traits.email");
    const firstNode = findInputNode(flow, "traits.name.first");
    const lastNode = findInputNode(flow, "traits.name.last");
    const passwordNode = findInputNode(flow, "password");

    return (
        <div className="min-h-dvh flex items-center justify-center bg-gray-200">
            <form onSubmit={handleSubmit} className="bg-white p-6 rounded-xl shadow w-96">
                <h1 className="text-xl font-semibold mb-4">{t("auth.register")}</h1>

                {flow.ui.messages?.map((m) => (
                    <p key={m.id} className="text-red-600 text-sm">
                        {m.text}
                    </p>
                ))}

                {hiddenNodes.map((node) => {
                    const attr = node.attributes as UiNodeInputAttributes;
                    return <input key={attr.name} {...attr} />;
                })}

                {emailNode && renderRegistration(emailNode, {type: "email", required: true}, flow)}

                {firstNode && renderRegistration(firstNode, {type: "text", required: true}, flow)}

                {lastNode && renderRegistration(lastNode, {type: "text", required: true}, flow)}

                {passwordNode && renderRegistration(
                    passwordNode,
                    {type: "password", required: true, autoComplete: "new-password"},
                    flow
                )}

                <button
                    disabled={loading}
                    className="w-full py-2 rounded text-white bg-teal-950 hover:bg-teal-900 disabled:bg-gray-400"
                >
                    {loading ? t("auth.creatingAccount") : t("auth.register")}
                </button>
                <p className="mt-4 text-center text-sm text-gray-600">
                    {t("auth.toLogin")} {' '}
                    <Link to="/login" className="text-teal-950 hover:underline">
                        {t("auth.loginLink")}
                    </Link>
                </p>
            </form>
        </div>
    );
}
