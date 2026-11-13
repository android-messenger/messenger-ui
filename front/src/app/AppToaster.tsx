import toast, {Toaster, ToastBar} from "react-hot-toast";

// The one place the app's toasts are set up.
//  - Below the status bar: in the Android app the page is drawn under it (edge to edge), and a toast at the
//    very top was half hidden. --wolp-sat is the top inset (App.css).
//  - A touch closes the toast. The library pauses its timers on "mouse enter" and resumes on "mouse leave";
//    a finger gives the first and never the second, so a toast that was touched stayed for good.
//  - They close by themselves: an error a little later than the rest.
export function AppToaster() {
    return (
        <Toaster
            position="top-center"
            containerStyle={{top: "calc(var(--wolp-sat, 0px) + 12px)"}}
            toastOptions={{duration: 3500, error: {duration: 6000}}}
        >
            {(t) => (
                <div
                    data-testid="toast"
                    style={{cursor: "pointer"}}
                    onClick={() => toast.dismiss(t.id)}
                    onTouchEnd={() => toast.dismiss(t.id)}
                >
                    <ToastBar toast={t}/>
                </div>
            )}
        </Toaster>
    );
}
