import { createContext, useCallback, useContext, useId, useMemo, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";

const ApiErrorContext = createContext(null);

function normalizeApiError(error, fallback = "Something went wrong.") {
  if (error == null) return fallback;
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || fallback;
  }
  if (error.name === "AbortError") return null;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  return message || fallback;
}

export function ErrorModal({
  eyebrow = "Error",
  title = "Something went wrong",
  detail,
  dismissLabel = "OK",
  onDismiss,
}) {
  const titleId = useId();
  const detailId = useId();

  return (
    <div
      className="confirm-modal-backdrop error-modal-backdrop"
      role="presentation"
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss?.();
        }
      }}
    >
      <section
        className="confirm-modal error-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detail ? detailId : undefined}
      >
        <p className="confirm-modal-eyebrow">{eyebrow}</p>
        <h3 className="confirm-modal-title" id={titleId}>
          <WarningCircle size={28} weight="regular" aria-hidden="true" />
          <span>{title}</span>
        </h3>
        {detail ? (
          <p className="confirm-modal-detail" id={detailId}>{detail}</p>
        ) : null}
        <div className="confirm-modal-actions">
          <button className="primary-button" type="button" onClick={onDismiss} autoFocus>
            {dismissLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ApiErrorProvider({ children }) {
  const [error, setError] = useState(null);

  const dismissApiError = useCallback(() => setError(null), []);

  const showApiError = useCallback((input, options = {}) => {
    const detail = normalizeApiError(input, options.fallback || "Something went wrong.");
    if (!detail) return;
    setError({
      eyebrow: options.eyebrow || "Error",
      title: options.title || "Something went wrong",
      detail,
      dismissLabel: options.dismissLabel || "OK",
    });
  }, []);

  const value = useMemo(() => ({ showApiError, dismissApiError }), [dismissApiError, showApiError]);

  return (
    <ApiErrorContext.Provider value={value}>
      {children}
      {error ? (
        <ErrorModal
          eyebrow={error.eyebrow}
          title={error.title}
          detail={error.detail}
          dismissLabel={error.dismissLabel}
          onDismiss={dismissApiError}
        />
      ) : null}
    </ApiErrorContext.Provider>
  );
}

export function useApiError() {
  const context = useContext(ApiErrorContext);
  if (!context) {
    throw new Error("useApiError must be used within ApiErrorProvider");
  }
  return context;
}
