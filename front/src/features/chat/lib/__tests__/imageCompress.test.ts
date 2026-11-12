import {describe, it, expect} from "vitest";
import {targetDimensions, compressImage} from "../imageCompress.ts";

describe("targetDimensions — proportional cap, no upscale", () => {
    it("leaves an image at/below the cap unchanged (never upscales)", () => {
        expect(targetDimensions(800, 600, 1600)).toEqual({width: 800, height: 600});
        expect(targetDimensions(1600, 900, 1600)).toEqual({width: 1600, height: 900});
    });
    it("downscales a landscape image by its longest side", () => {
        expect(targetDimensions(3200, 1600, 1600)).toEqual({width: 1600, height: 800});
    });
    it("downscales a portrait image by its longest side", () => {
        expect(targetDimensions(1000, 2000, 1600)).toEqual({width: 800, height: 1600});
    });
    it("downscales a square image", () => {
        expect(targetDimensions(2400, 2400, 1600)).toEqual({width: 1600, height: 1600});
    });
    it("is safe on a zero dimension", () => {
        expect(targetDimensions(0, 0, 1600)).toEqual({width: 0, height: 0});
    });
});

const opts = {maxDimension: 1600, quality: 0.8, minBytes: 150 * 1024};

describe("compressImage — guards", () => {
    it("returns a non-image file untouched", async () => {
        const f = new File(["hello"], "notes.txt", {type: "text/plain"});
        expect(await compressImage(f, opts)).toBe(f);
    });
    it("returns a GIF untouched (animation must not be flattened)", async () => {
        const f = new File([new Uint8Array(300 * 1024)], "a.gif", {type: "image/gif"});
        expect(await compressImage(f, opts)).toBe(f);
    });
    it("returns an image below minBytes untouched", async () => {
        const f = new File([new Uint8Array(1000)], "tiny.jpg", {type: "image/jpeg"});
        expect(await compressImage(f, opts)).toBe(f);
    });
    it("degrades to the original when decoding isn't available (no throw)", async () => {
        // jsdom has no real createImageBitmap → the decode throws → compressImage returns the original.
        const f = new File([new Uint8Array(200 * 1024)], "big.jpg", {type: "image/jpeg"});
        const out = await compressImage(f, opts);
        expect(out).toBe(f);
    });
});
