import {describe, it, expect} from "vitest";
import {evictToFit, type CacheIndexEntry} from "../db";

const e = (id: string, size: number): CacheIndexEntry => ({id, size});

describe("evictToFit — size-bounded media cache eviction", () => {
    it("keeps everything when under budget", () => {
        const idx = [e("a", 10), e("b", 20)];
        expect(evictToFit(idx, 100)).toEqual({kept: idx, evicted: []});
    });

    it("evicts OLDEST-first until the total fits", () => {
        const idx = [e("a", 40), e("b", 40), e("c", 40)]; // 120, budget 100
        const {kept, evicted} = evictToFit(idx, 100);
        expect(evicted).toEqual(["a"]);                 // oldest dropped → 80 ≤ 100
        expect(kept.map((x) => x.id)).toEqual(["b", "c"]);
    });

    it("evicts multiple when needed, oldest first", () => {
        const idx = [e("a", 50), e("b", 50), e("c", 50), e("d", 50)]; // 200, budget 60
        const {kept, evicted} = evictToFit(idx, 60);
        expect(evicted).toEqual(["a", "b", "c"]);
        expect(kept.map((x) => x.id)).toEqual(["d"]);
    });

    it("always keeps the newest entry even if it alone exceeds the budget", () => {
        const idx = [e("a", 10), e("big", 999)];
        const {kept, evicted} = evictToFit(idx, 100);
        expect(evicted).toEqual(["a"]);
        expect(kept.map((x) => x.id)).toEqual(["big"]); // never evicts down to empty
    });

    it("does not mutate the input array", () => {
        const idx = [e("a", 40), e("b", 40), e("c", 40)];
        evictToFit(idx, 50);
        expect(idx.map((x) => x.id)).toEqual(["a", "b", "c"]);
    });
});
