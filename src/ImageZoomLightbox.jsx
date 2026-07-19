import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react";

function arrowNavigationDelta(key, columnCount = 1) {
  const columns = Math.max(1, Math.floor(columnCount) || 1);
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  if (key === "ArrowUp") return -columns;
  if (key === "ArrowDown") return columns;
  return 0;
}

function LightboxNavArrows({ onNavigate, label = "item", canPrev = false, canNext = false }) {
  if (!onNavigate) return null;
  return (
    <div className="viewer-nav-arrows">
      <button
        className="viewer-nav-arrow viewer-nav-arrow--prev"
        type="button"
        onClick={() => onNavigate(-1)}
        disabled={!canPrev}
        aria-label={`Previous ${label}`}
      >
        <CaretLeft size={22} weight="bold" aria-hidden="true" />
      </button>
      <button
        className="viewer-nav-arrow viewer-nav-arrow--next"
        type="button"
        onClick={() => onNavigate(1)}
        disabled={!canNext}
        aria-label={`Next ${label}`}
      >
        <CaretRight size={22} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

export function ImageZoomLightbox({
  src,
  alt,
  onClose,
  onNavigate,
  canPrev = false,
  canNext = false,
  gridColumns = 1,
  label = "item",
  className = "",
}) {
  const scrollerRef = useRef(null);
  const frameRef = useRef(null);
  const pendingFocusRef = useRef(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    setZoomed(false);
    if (scrollerRef.current) {
      scrollerRef.current.scrollLeft = 0;
      scrollerRef.current.scrollTop = 0;
    }
  }, [src]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const delta = arrowNavigationDelta(event.key, gridColumns);
      if (!delta || !onNavigate) return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(delta);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [gridColumns, onClose, onNavigate]);

  useLayoutEffect(() => {
    if (!zoomed || !pendingFocusRef.current || !scrollerRef.current || !frameRef.current) return;
    const { x, y } = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const scroller = scrollerRef.current;
    const frame = frameRef.current;
    scroller.scrollLeft = Math.max(0, frame.offsetWidth * x - scroller.clientWidth / 2);
    scroller.scrollTop = Math.max(0, frame.offsetHeight * y - scroller.clientHeight / 2);
  }, [zoomed]);

  const toggleZoom = (event) => {
    if (zoomed) {
      if (scrollerRef.current) {
        scrollerRef.current.scrollLeft = 0;
        scrollerRef.current.scrollTop = 0;
      }
      setZoomed(false);
      return;
    }
    const image = event.currentTarget.querySelector("img");
    const rect = (image || event.currentTarget).getBoundingClientRect();
    if (!rect.width || !rect.height) {
      setZoomed(true);
      return;
    }
    pendingFocusRef.current = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
    setZoomed(true);
  };

  if (!src) return null;

  return (
    <div
      ref={scrollerRef}
      className={`image-zoom-lightbox${zoomed ? " is-zoomed" : ""}${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Zoomed image"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button className="image-zoom-lightbox__close" type="button" onClick={onClose} aria-label="Close zoomed image">
        <X size={24} weight="light" aria-hidden="true" />
      </button>
      <LightboxNavArrows onNavigate={onNavigate} label={label} canPrev={canPrev} canNext={canNext} />
      <button
        ref={frameRef}
        className={`image-zoom-lightbox__frame${zoomed ? " is-zoomed" : ""}`}
        type="button"
        onClick={toggleZoom}
        aria-label={zoomed ? "Minimize image" : "Zoom image"}
      >
        <img src={src} alt={alt || ""} draggable={false} />
      </button>
    </div>
  );
}
