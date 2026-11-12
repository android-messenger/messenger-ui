// Generic confirm dialog primitive. Lives in shared/ui (a leaf layer) so both pages and features can
// import it downward — it was in widgets/, which sits ABOVE features, so features/call importing it was
// an upward FSD violation.
export default function ConfirmModal({
  title,
  message,
  confirmText = "Sí",
  cancelText = "No",
  onConfirm,
  onCancel,
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-lg w-[90%] max-w-sm p-6 text-center">
        <h2 className="text-lg font-semibold mb-3">{title}</h2>

        <p className="text-gray-600 mb-6">{message}</p>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 border rounded-lg py-2 hover:bg-gray-100"
          >
            {cancelText}
          </button>

          <button
            onClick={onConfirm}
            className="flex-1 bg-red-600 text-white rounded-lg py-2 hover:bg-red-700"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
