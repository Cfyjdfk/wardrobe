import { Trash } from "@phosphor-icons/react";

export function ConfirmDeleteModal({
  eyebrow = "Delete",
  title,
  detail,
  confirmLabel = "Delete",
  busy = false,
  elevated = false,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      className={`confirm-modal-backdrop${elevated ? " confirm-modal-backdrop--elevated" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel?.();
      }}
    >
      <section
        className="confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        aria-describedby="confirm-delete-detail"
      >
        <p className="confirm-modal-eyebrow">{eyebrow}</p>
        <h3 className="confirm-modal-title" id="confirm-delete-title">{title}</h3>
        {detail ? (
          <p className="confirm-modal-detail" id="confirm-delete-detail">{detail}</p>
        ) : null}
        <div className="confirm-modal-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button confirm-delete-button" type="button" disabled={busy} onClick={onConfirm}>
            <Trash size={15} weight="regular" aria-hidden="true" />
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
