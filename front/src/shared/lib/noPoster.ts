// Android WebView draws its own grey "play" placeholder in a <video> until the first frame arrives.
// A transparent 1×1 poster suppresses it, so a live <video> (call, camera preview) stays plain black
// while waiting for frames.
export const NO_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
