import type {
    LoginFlow,
    RecoveryFlow,
    RegistrationFlow,
    SettingsFlow,
    VerificationFlow,
    UpdateLoginFlowBody,
    UpdateRegistrationFlowBody,
    UiNode, UiNodeInputAttributes,
} from "@ory/client";
import type { AxiosError } from "axios";
import { kratos } from "./kratos";


/* ───────────────── Session ───────────────── */

export async function requireNoSession(): Promise<boolean> {
    try {
        await kratos.toSession();
        return false;
    } catch {
        return true;
    }
}

/* ───────────────── Login ───────────────── */

export async function initLoginFlow(): Promise<LoginFlow> {
    const { data } = await kratos.createBrowserLoginFlow();
    return data;
}

export async function submitLoginFlow(
    flowId: string,
    body: UpdateLoginFlowBody
) {
    return kratos.updateLoginFlow({
        flow: flowId,
        updateLoginFlowBody: body,
    });
}

/* ───────────────── Registration ───────────────── */

export async function initRegistrationFlow(): Promise<RegistrationFlow> {
    const { data } = await kratos.createBrowserRegistrationFlow();
    return data;
}

export async function submitRegistrationFlow(
    flowId: string,
    body: UpdateRegistrationFlowBody
) {
    return kratos.updateRegistrationFlow({
        flow: flowId,
        updateRegistrationFlowBody: body,
    });
}

/* ───────────────── Verification / recovery / settings (codes by email) ───────────────── */

export async function initVerificationFlow(): Promise<VerificationFlow> {
    return (await kratos.createBrowserVerificationFlow()).data;
}

export async function getVerificationFlow(id: string): Promise<VerificationFlow> {
    return (await kratos.getVerificationFlow({id})).data;
}

/** `{method:"code", email}` sends a code, `{method:"code", code}` checks it. Returns the updated flow. */
export async function submitVerificationFlow(flowId: string, body: {email?: string; code?: string; csrf_token: string}) {
    return (await kratos.updateVerificationFlow({flow: flowId, updateVerificationFlowBody: {method: "code", ...body}})).data;
}

export async function initRecoveryFlow(): Promise<RecoveryFlow> {
    return (await kratos.createBrowserRecoveryFlow()).data;
}

export async function getRecoveryFlow(id: string): Promise<RecoveryFlow> {
    return (await kratos.getRecoveryFlow({id})).data;
}

/** A valid code answers 422 `browser_location_change_required` → settings flow (see {@link redirectFlowId}). */
export async function submitRecoveryFlow(flowId: string, body: {email?: string; code?: string; csrf_token: string}) {
    return (await kratos.updateRecoveryFlow({flow: flowId, updateRecoveryFlowBody: {method: "code", ...body}})).data;
}

export async function getSettingsFlow(id: string): Promise<SettingsFlow> {
    return (await kratos.getSettingsFlow({id})).data;
}

export async function submitSettingsPassword(flowId: string, password: string, csrf_token: string) {
    return (await kratos.updateSettingsFlow({
        flow: flowId,
        updateSettingsFlowBody: {method: "password", password, csrf_token},
    })).data;
}

/**
 * Kratos asks an SPA to "redirect the browser" (422 `browser_location_change_required`) to one of
 * OUR ui_url pages, e.g. https://m.wolpertinger.work/messenger-ui/settings?flow=… after a recovery
 * code. We stay on the current origin (the app's LoginActivity serves the same pages on :8444 and
 * refuses other hosts) and only take the page and the flow id: → {page: "settings", flow: "…"}.
 */
export function redirectFlowId(error: unknown): {page: string; flow: string} | null {
    const to = (error as AxiosError<{redirect_browser_to?: string}>).response?.data?.redirect_browser_to;
    if (!to) return null;
    try {
        const u = new URL(to);
        const flow = u.searchParams.get("flow");
        const page = u.pathname.replace(/\/$/, "").split("/").pop() ?? "";
        return flow && page ? {page, flow} : null;
    } catch {
        return null;
    }
}

/** The verification flow Kratos started right after registration (continue_with), if any. */
export function verificationFlowId(data: {continue_with?: Array<{action: string; flow?: {id?: string}}>} | undefined): string | null {
    const c = data?.continue_with?.find((x) => x.action === "show_verification_ui");
    return c?.flow?.id ?? null;
}

/* ───────────────── Logout ───────────────── */

export async function logout(): Promise<string> {
    const { data } = await kratos.createBrowserLogoutFlow();
    return data.logout_url;
}

/* ───────────────── Helpers ───────────────── */

export function extractFieldErrors(
    flow: { ui: { nodes: UiNode[] } },
    name: string
) {
    return flow.ui.nodes
        .filter(
            (n) =>
                n.type === "input" &&
                (n.attributes as UiNodeInputAttributes).name === name
        )
        .flatMap((n) => n.messages ?? []);
}


export function handleFlowError<T extends { ui:  { nodes: UiNode[] } }>(
    error: unknown,
    recreateFlow: () => Promise<T>,
    setFlow: (flow: T) => void
) {
    const err = error as AxiosError<T>;

    if (err.response?.status === 410) {
        recreateFlow().then(setFlow);
        return;
    }

    if (err.response?.data) {
        setFlow(err.response.data);
    }
}

type KratosFlow = LoginFlow | RegistrationFlow | VerificationFlow | RecoveryFlow | SettingsFlow;

export function findInputNode(flow: KratosFlow, name: string): UiNode | undefined {
    return flow.ui.nodes.find(
        (n) =>
            n.type === "input" &&
            (n.attributes as UiNodeInputAttributes).name === name
    );
}

export function findHiddenNodes(flow: KratosFlow): UiNode[] {
    return flow.ui.nodes.filter(
        (n) =>
            n.type === "input" &&
            (n.attributes as UiNodeInputAttributes).type === "hidden"
    );
}

export function isInputNode(
    node: UiNode
): node is UiNode & { attributes: UiNodeInputAttributes } {
    return node.type === "input";
}

/** The csrf_token of a flow (every browser flow has one). */
export function csrfOf(flow: {ui: {nodes: Array<{attributes: unknown}>}}): string {
    for (const n of flow.ui.nodes) {
        const a = n.attributes as {name?: string; value?: unknown};
        if (a.name === "csrf_token") return String(a.value ?? "");
    }
    return "";
}
