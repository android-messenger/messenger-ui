// One secret message is decrypted once (spec 003, FR-045).
//
// The library spends a message key on the first decryption and refuses the same envelope after that. A
// message can reach the interface twice at the same moment — over the socket and in an answer of the
// history, or as the same frame sent again. Everyone who is about to decrypt a message of a peer does it
// here, one after another: look for the stored text, decrypt only if there is none, store the text — and
// only then the next one looks.

const queues = new Map<string, Promise<unknown>>();

/** Runs `job` after every job of this peer that was given earlier has ended, well or not. */
export function inPeerOrder<T>(peer: string, job: () => Promise<T>): Promise<T> {
    const run = (queues.get(peer) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    queues.set(peer, tail);
    void tail.then(() => { if (queues.get(peer) === tail) queues.delete(peer); });
    return run;
}
