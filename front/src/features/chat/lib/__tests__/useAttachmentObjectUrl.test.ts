import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {renderHook, waitFor, act} from "@testing-library/react";
import {useAttachmentObjectUrl} from "../useAttachmentObjectUrl";

const mkBlob = (type = "image/webp") => new Blob(["x"], {type});

beforeEach(() => {
    let n = 0;
    (URL as unknown as {createObjectURL: unknown}).createObjectURL = vi.fn(() => "blob:mock-" + (++n));
    (URL as unknown as {revokeObjectURL: unknown}).revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("useAttachmentObjectUrl", () => {
    it("serves the cached blob with NO network on a cache hit", async () => {
        const load = vi.fn(async () => mkBlob());
        const resolveUrl = vi.fn(async () => "should-not-be-called");
        const {result} = renderHook(() => useAttachmentObjectUrl({attachmentId: "a1", resolveUrl, load}));
        await waitFor(() => expect(result.current.url).toMatch(/^blob:mock-/));
        expect(load).toHaveBeenCalledWith("a1");
        expect(resolveUrl).not.toHaveBeenCalled();
        expect(result.current.failed).toBe(false);
    });

    it("on a miss: resolve → fetch → transform → save → serve (a blob URL, not the presigned)", async () => {
        const load = vi.fn(async () => null);
        const save = vi.fn(async () => {});
        const transform = vi.fn(async (b: Blob) => b);
        const resolveUrl = vi.fn(async () => "https://edge/presigned");
        const fetchMock = vi.fn(async () => ({ok: true, blob: async () => mkBlob()}));
        vi.stubGlobal("fetch", fetchMock);

        const {result} = renderHook(() =>
            useAttachmentObjectUrl({attachmentId: "a2", resolveUrl, load, save, transform}));

        await waitFor(() => expect(result.current.url).toMatch(/^blob:mock-/));
        expect(resolveUrl).toHaveBeenCalledWith("a2");
        expect(fetchMock).toHaveBeenCalledWith("https://edge/presigned", expect.anything());
        expect(transform).toHaveBeenCalled();
        expect(save).toHaveBeenCalledWith("a2", expect.any(Blob));
    });

    it("retry() invalidates the cache entry and re-resolves a fresh presigned URL", async () => {
        const load = vi.fn(async () => null);
        const invalidate = vi.fn(async () => {});
        const resolveUrl = vi.fn(async () => "https://edge/p");
        vi.stubGlobal("fetch", vi.fn(async () => ({ok: true, blob: async () => mkBlob()})));

        const {result} = renderHook(() =>
            useAttachmentObjectUrl({attachmentId: "a3", resolveUrl, load, invalidate}));
        await waitFor(() => expect(result.current.url).toMatch(/^blob:mock-/));

        resolveUrl.mockClear();
        act(() => result.current.retry());
        await waitFor(() => expect(resolveUrl).toHaveBeenCalledWith("a3"));
        expect(invalidate).toHaveBeenCalledWith("a3");
    });
});
