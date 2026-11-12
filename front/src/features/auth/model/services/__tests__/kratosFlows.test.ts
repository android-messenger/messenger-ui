import {describe, it, expect, vi} from "vitest";
import {extractFieldErrors, findInputNode, findHiddenNodes, isInputNode, handleFlowError} from "../kratosFlows";
import type {UiNode} from "@ory/client";

// The flow fns (init/submit/logout) hit the kratos client — mock it away so importing the module is
// side-effect-free. Only the PURE helpers below are exercised.
vi.mock("../kratos", () => ({kratos: {}}));

const input = (name: string, type = "text", messages: {id: number; text: string}[] = []): UiNode => ({
    type: "input",
    group: "default",
    attributes: {name, type, node_type: "input"},
    messages,
    meta: {},
} as unknown as UiNode);

const textNode = (): UiNode => ({type: "text", group: "default", attributes: {}, messages: [], meta: {}} as unknown as UiNode);

describe("kratosFlows pure helpers", () => {
    it("extractFieldErrors collects messages for the named input only", () => {
        const flow = {ui: {nodes: [
            input("password", "password", [{id: 1, text: "too short"}]),
            input("identifier", "text", [{id: 2, text: "required"}]),
        ]}};
        expect(extractFieldErrors(flow, "password").map((m) => m.text)).toEqual(["too short"]);
        expect(extractFieldErrors(flow, "missing")).toEqual([]);
    });

    it("findInputNode / findHiddenNodes / isInputNode select the right nodes", () => {
        const nodes = [textNode(), input("csrf_token", "hidden"), input("identifier", "text")];
        const flow = {ui: {nodes}} as Parameters<typeof findInputNode>[0];
        expect(findInputNode(flow, "identifier")).toBe(nodes[2]);
        expect(findInputNode(flow, "nope")).toBeUndefined();
        expect(findHiddenNodes(flow)).toEqual([nodes[1]]);
        expect(isInputNode(nodes[1])).toBe(true);
        expect(isInputNode(nodes[0])).toBe(false);
    });

    it("handleFlowError: 410 recreates the flow, otherwise sets the response body", () => {
        const recreate = vi.fn(async () => ({ui: {nodes: []}}));
        const setFlow = vi.fn();

        handleFlowError({response: {status: 410}}, recreate, setFlow);
        expect(recreate).toHaveBeenCalledTimes(1);

        const body = {ui: {nodes: [input("x")]}};
        handleFlowError({response: {status: 400, data: body}}, recreate, setFlow);
        expect(setFlow).toHaveBeenCalledWith(body);
    });
});

describe("kratosFlows: email flows", () => {
    it("redirectFlowId takes the page and flow id from browser_location_change_required", async () => {
        const {redirectFlowId} = await import("../kratosFlows");
        const err = {response: {status: 422, data: {redirect_browser_to: "https://m.wolpertinger.work/messenger-ui/settings?flow=abc-1"}}};
        expect(redirectFlowId(err)).toEqual({page: "settings", flow: "abc-1"});
        expect(redirectFlowId({response: {status: 400, data: {}}})).toBeNull();
        expect(redirectFlowId({response: {data: {redirect_browser_to: "not a url"}}})).toBeNull();
        expect(redirectFlowId({response: {data: {redirect_browser_to: "https://x/messenger-ui/settings"}}})).toBeNull();
        expect(redirectFlowId(new Error("network"))).toBeNull();
    });

    it("verificationFlowId finds show_verification_ui in continue_with", async () => {
        const {verificationFlowId} = await import("../kratosFlows");
        expect(verificationFlowId({continue_with: [{action: "show_verification_ui", flow: {id: "v1"}}]})).toBe("v1");
        expect(verificationFlowId({continue_with: [{action: "set_ory_session_token"}]})).toBeNull();
        expect(verificationFlowId(undefined)).toBeNull();
    });

    it("csrfOf returns the csrf_token node value", async () => {
        const {csrfOf} = await import("../kratosFlows");
        expect(csrfOf({ui: {nodes: [{attributes: {name: "email"}}, {attributes: {name: "csrf_token", value: "tok"}}]}})).toBe("tok");
        expect(csrfOf({ui: {nodes: []}})).toBe("");
    });
});
