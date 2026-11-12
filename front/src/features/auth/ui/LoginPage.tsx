import {type FormEvent,  useState} from "react";
import {Link, useNavigate} from "react-router-dom";
import {useTranslation} from "react-i18next";
import type {LoginFlow, UiNode, UiNodeInputAttributes, UpdateLoginFlowBody} from "@ory/client";
import {
    extractFieldErrors,
    findHiddenNodes,
    findInputNode,
    handleFlowError,
    initLoginFlow, isInputNode,
    submitLoginFlow
} from "@/features/auth/model/services/kratosFlows.ts";
import useNoSessionFlow from "@/features/auth/hooks/useNoSessionFlow.ts";
import {KRATOS_ADDRESS_NOT_VERIFIED, loginMessageText} from "@/features/auth/model/loginMessages.ts";


export default function LoginPage() {
    const {t} = useTranslation();
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();
    const [flow, setFlow] = useNoSessionFlow(initLoginFlow, navigate);


    async function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!flow || loading) return;

        setLoading(true);

        try {
            const formData = new FormData(e.currentTarget);

            await submitLoginFlow(flow.id, {
                method: "password",
                identifier: formData.get("identifier"),
                password: formData.get("password"),
                csrf_token: formData.get("csrf_token"),
            } as UpdateLoginFlowBody);

            navigate("/", {replace: true});
        } catch (err) {
            handleFlowError(err, initLoginFlow, setFlow);
        } finally {
            setLoading(false);
        }
    }

    if (!flow) return <div className="p-6">{t("common.loading")}</div>;

    function renderInput(
        node: UiNode,
        props: {
            type: string;
            required?: boolean;
            autoComplete?: string;
            autoFocus?: boolean;
        },
        flow: LoginFlow
    ) {
        if (!isInputNode(node)) return null;
        const attr = node.attributes;
        const errors = extractFieldErrors(flow, attr.name);

        return (
            <div key={attr.name} className="mb-3">
                {node.meta?.label?.text && (
                    <label className="block text-sm font-medium mb-1">
                        {node.meta.label.text}
                    </label>
                )}

                <input
                    name={attr.name}
                    type={props.type}
                    autoComplete={props.autoComplete}
                    autoFocus={props.autoFocus}
                    defaultValue={attr.value ?? ""}
                    required={props.required}
                    className="w-full border rounded px-3 py-2"
                />

                {errors.map((e) => (
                    <p key={e.id} className="text-red-600 text-sm">
                        {e.text}
                    </p>
                ))}
            </div>
        );
    }


    const hiddenNodes = findHiddenNodes(flow);
    const identifierNode = findInputNode(flow, "identifier");
    const passwordNode = findInputNode(flow, "password");

    return (
        <div className="min-h-dvh flex items-center justify-center bg-gray-200">
            <form
                onSubmit={handleSubmit}
                className="bg-white p-6 rounded-xl shadow w-96"
            >
                <h1 className="text-xl font-semibold mb-4">{t("auth.login")}</h1>

                {flow.ui.messages?.map((m) => (
                    <p key={m.id} className="text-red-600 mb-2">
                        {loginMessageText(m, t)}
                        {m.id === KRATOS_ADDRESS_NOT_VERIFIED && (
                            <>{' '}<Link to="/verify" className="text-teal-950 underline">{t("auth.verifyLink")}</Link></>
                        )}
                    </p>
                ))}

                {hiddenNodes.map((node) => {
                    const attr = node.attributes as UiNodeInputAttributes;
                    return <input key={attr.name} {...attr} />;
                })}

                {identifierNode && renderInput(
                    identifierNode,
                    {
                        type: "email",
                        required: true,
                        autoComplete: "email",
                        autoFocus: true,
                    },
                    flow
                )}

                {passwordNode && renderInput(
                    passwordNode,
                    {
                        type: "password",
                        required: true,
                        autoComplete: "current-password",
                    },
                    flow
                )}

                <button
                    disabled={loading}
                    className="w-full py-2 rounded text-white bg-teal-950 hover:bg-teal-900 disabled:bg-gray-400"
                >
                    {loading ? t("auth.signingIn") : t("auth.login")}
                </button>

                <p className="mt-3 text-center text-sm">
                    <Link to="/recovery" className="text-teal-950 hover:underline">{t("auth.forgotPassword")}</Link>
                </p>

                <p className="mt-2 text-center text-sm text-gray-600">
                    {t("auth.noAccount")}{' '}
                    <Link to="/register" className="text-teal-950 hover:underline">
                        {t("auth.registerLink")}
                    </Link>
                </p>
            </form>
        </div>
    );
}
