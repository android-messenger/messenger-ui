import {logger} from "@/shared/logger/logger.ts";

export type CompressOptions = {
    maxDimension: number;   // longest side cap (px); images at/below are not upscaled
    quality: number;        // 0..1 → WebP quality
    minBytes: number;       // images below this are returned untouched
};

// Raster formats we recompress to WebP. GIF (animation) and SVG (vector) are deliberately excluded —
// flattening them via canvas would break them.
const COMPRESSIBLE = /^image\/(jpe?g|png|webp|bmp)$/i;

/**
 * Proportional target dimensions: cap the LONGEST side at maxDimension, preserve aspect ratio, and
 * NEVER upscale. Pure — unit-tested in isolation.
 */
export function targetDimensions(width: number, height: number, maxDimension: number): {width: number; height: number} {
    const longest = Math.max(width, height);
    if (longest <= maxDimension || longest === 0) return {width, height};
    const scale = maxDimension / longest;
    return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

/**
 * Downscale an already-fetched image Blob to a small WebP thumbnail (for the attachment cache). Operates
 * on bytes we own — createImageBitmap + canvas — so there's no cross-origin/taint concern (unlike reading
 * back a displayed <img>). Returns the original blob on any failure (still cacheable, just larger).
 */
export async function blobToThumb(blob: Blob, maxDimension: number, quality: number): Promise<Blob> {
    try {
        const bitmap = await createImageBitmap(blob);
        const {width, height} = targetDimensions(bitmap.width, bitmap.height, maxDimension);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { bitmap.close?.(); return blob; }
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        return await new Promise<Blob>((resolve) =>
            canvas.toBlob((b) => resolve(b || blob), "image/webp", quality));
    } catch {
        return blob;
    }
}

/**
 * Downscale an image proportionally to `maxDimension` and re-encode it as WebP at `quality`, entirely
 * client-side (before the presigned upload). Decode + resize run natively (createImageBitmap + a 2D
 * canvas); the WebP encode uses jSquash (lazy-loaded WASM, mozjpeg-grade) and falls back to the native
 * canvas encoder if the WASM path fails. Returns the ORIGINAL file untouched when it isn't a
 * compressible raster image, is already below `minBytes`, or the result would be larger (never upload a
 * bigger file). Any failure degrades to sending the original.
 */
export async function compressImage(file: File, opts: CompressOptions): Promise<File> {
    if (!COMPRESSIBLE.test(file.type) || file.size < opts.minBytes) return file;
    try {
        const bitmap = await createImageBitmap(file);
        const {width, height} = targetDimensions(bitmap.width, bitmap.height, opts.maxDimension);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { bitmap.close?.(); return file; }
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        const imageData = ctx.getImageData(0, 0, width, height);

        // Primary: jSquash WebP (better ratio). Fallback: the browser's native canvas WebP encoder.
        let blob: Blob;
        try {
            const encode = (await import("@jsquash/webp/encode")).default;
            const buf = await encode(imageData, {quality: Math.round(opts.quality * 100)});
            blob = new Blob([buf], {type: "image/webp"});
        } catch (e) {
            logger.debug("jSquash webp encode unavailable, using canvas fallback", e as Error);
            blob = await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas toBlob null"))), "image/webp", opts.quality));
        }

        if (blob.size >= file.size) return file; // compression didn't help → keep the original
        const name = file.name.replace(/\.[^.]+$/, "") + ".webp";
        return new File([blob], name, {type: "image/webp", lastModified: file.lastModified});
    } catch (e) {
        logger.debug("image compression failed, sending original", e as Error);
        return file;
    }
}
