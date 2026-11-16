import type {AppDispatch, RootState} from "@/store/store.ts";

/** The store as the steps of an incoming message see it (the middleware's store). */
export interface IncomingStore {
    getState: () => RootState;
    dispatch: AppDispatch;
}
