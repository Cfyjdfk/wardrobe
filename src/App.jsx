import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, BookmarkSimple, CaretLeft, CaretRight, Check, MagnifyingGlass, Plus, Sparkle, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import Fuse from "fuse.js";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal.jsx";
import { ImageZoomLightbox } from "./ImageZoomLightbox.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";
const AUTOSAVE_MS = 1000;
const GARMENT_DRAG_MIME = "application/x-wardrobe-garment";

const PART_TYPES = [
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
];

const TYPES = [
  { id: "all", label: "All" },
  ...PART_TYPES,
  { id: "not_owned", label: "Not owned", icon: "bookmark" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(PART_TYPES.map((type, index) => [type.id, index]));

const GARMENT_FUSE_OPTIONS = {
  keys: [
    { name: "name", weight: 0.55 },
    { name: "tags", weight: 0.3 },
    { name: "typeLabel", weight: 0.1 },
    { name: "typeSingular", weight: 0.05 },
  ],
  threshold: 0.38,
  ignoreLocation: true,
};

const OUTFIT_FUSE_OPTIONS = {
  keys: [
    { name: "name", weight: 0.4 },
    { name: "prompt", weight: 0.25 },
    { name: "setting", weight: 0.15 },
    { name: "garmentNames", weight: 0.12 },
    { name: "garmentTags", weight: 0.08 },
  ],
  threshold: 0.38,
  ignoreLocation: true,
};

function sortByPart(items) {
  return [...items].sort((a, b) => {
    const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
    if (typeDifference) return typeDifference;
    return a.id.localeCompare(b.id);
  });
}

function adjacentId(ids, currentId, delta) {
  if (!ids.length) return null;
  const index = ids.indexOf(currentId);
  if (index === -1) return ids[0];
  const next = index + delta;
  if (next < 0 || next >= ids.length) return null;
  return ids[next];
}

function navigationBounds(ids, currentId) {
  const index = ids.indexOf(currentId);
  if (index === -1) return { canPrev: false, canNext: ids.length > 0 };
  return { canPrev: index > 0, canNext: index < ids.length - 1 };
}

function arrowNavigationDelta(key) {
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  return 0;
}

function lockBodyScroll() {
  const scrollY = window.scrollY;
  document.body.classList.add("viewer-open");
  document.body.style.top = `-${scrollY}px`;
  return () => {
    document.body.classList.remove("viewer-open");
    document.body.style.top = "";
    window.scrollTo(0, scrollY);
  };
}

function formatTokenCount(count) {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return `${Math.round(count).toLocaleString()}`;
}

function formatUsd(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (amount < 0.01) return `~$${amount.toFixed(3)}`;
  return `~$${amount.toFixed(2)}`;
}

function costMetaFromRecord(cost, label) {
  if (!cost) return null;
  const tokens = formatTokenCount(cost.totalTokens);
  const usd = formatUsd(cost.estimatedUsd);
  if (!tokens && !usd) return null;
  return {
    label,
    tokens,
    usd,
    title: cost.model ? `Model ${cost.model}` : undefined,
  };
}

function tokenMetaEntries(costs, singleCost) {
  if (singleCost) return [costMetaFromRecord(singleCost, null)].filter(Boolean);
  if (!costs) return [];
  return [
    costMetaFromRecord(costs.garment, "Garment"),
    costMetaFromRecord(costs.modeled, "Modeled image"),
  ].filter(Boolean);
}

function GenerationCostMeta({ costs, singleCost }) {
  const entries = tokenMetaEntries(costs, singleCost);
  if (!entries.length) return null;
  const isOutfit = Boolean(singleCost);
  return (
    <p className="generation-cost" aria-label="Generation cost">
      {isOutfit && <span className="generation-cost-label">Estimated cost</span>}
      {entries.map((entry) => (
        <span className="generation-cost-item" key={entry.label || "outfit"} title={entry.title}>
          {entry.label && <span className="generation-cost-label">{entry.label}</span>}
          {entry.usd && <span className="generation-cost-usd">{entry.usd}</span>}
          {entry.usd && entry.tokens && <span className="generation-cost-sep" aria-hidden="true">·</span>}
          {entry.tokens && <span className="generation-cost-tokens">{entry.tokens}</span>}
        </span>
      ))}
    </p>
  );
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function ViewerNavArrows({ onNavigate, label = "item", canPrev = false, canNext = false }) {
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

function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function isOwned(item) {
  return item?.owned !== false;
}

function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
    owned: isOwned(item),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

const GALLERY_SKELETON_COUNT = 12;

function GallerySkeleton({ count = GALLERY_SKELETON_COUNT }) {
  return (
    <section className="gallery-grid gallery-grid--skeleton" aria-busy="true" aria-label="Loading wardrobe">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="gallery-skeleton-item"
          style={{ "--skeleton-delay": `${index * 45}ms` }}
          aria-hidden="true"
        />
      ))}
    </section>
  );
}

const GalleryItem = memo(function GalleryItem({ item, selected, hidden, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";
  const owned = isOwned(item);
  const dragMoved = useRef(false);

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}${owned ? "" : " is-not-owned"}`}
      type="button"
      hidden={hidden}
      tabIndex={hidden ? -1 : undefined}
      draggable={!hidden}
      onDragStart={(event) => {
        dragMoved.current = false;
        event.dataTransfer.setData(GARMENT_DRAG_MIME, item.id);
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "copy";
        const preview = event.currentTarget.querySelector("img");
        if (preview) {
          const rect = preview.getBoundingClientRect();
          event.dataTransfer.setDragImage(preview, rect.width / 2, rect.height / 2);
        }
      }}
      onDrag={(event) => {
        if (Math.abs(event.movementX) > 2 || Math.abs(event.movementY) > 2) dragMoved.current = true;
      }}
      onClick={() => {
        if (dragMoved.current) {
          dragMoved.current = false;
          return;
        }
        onOpen(item.id);
      }}
      aria-label={`View ${item.name || type}${owned ? "" : ", not owned"}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
      {!owned && (
        <span className="gallery-item-owned" title="Not owned" aria-hidden="true">
          <BookmarkSimple size={13} weight="fill" />
        </span>
      )}
    </button>
  );
});

function GallerySearch({ value, onChange, placeholder = "Search name or details", label = "Search" }) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const expanded = open || !!value.trim();

  return (
    <div className={`gallery-search${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="gallery-search-toggle"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        aria-label={expanded ? label : "Open search"}
      >
        <MagnifyingGlass size={17} weight="bold" aria-hidden="true" />
      </button>
      <div className="gallery-search-field">
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            if (!value.trim()) setOpen(false);
          }}
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          spellCheck="false"
        />
        {!!value && (
          <button
            type="button"
            className="gallery-search-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            <X size={12} weight="bold" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function OutfitComposer({ items, prompt, onPromptChange, error, onAdd, onRemove, onGenerate }) {
  const [draggingOver, setDraggingOver] = useState(false);
  const ordered = sortByPart(items);
  const canGenerate = ordered.length >= 2;

  const acceptDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingOver(false);
    const id = event.dataTransfer.getData(GARMENT_DRAG_MIME) || event.dataTransfer.getData("text/plain");
    if (id) onAdd(id);
  };

  return (
    <div className="outfit-composer-shell">
      <section
        className={`outfit-composer${draggingOver ? " is-over" : ""}${ordered.length ? " has-items" : ""}`}
        aria-label="Outfit composer"
        onDragEnter={(event) => {
          if (![...event.dataTransfer.types].includes(GARMENT_DRAG_MIME) && ![...event.dataTransfer.types].includes("text/plain")) return;
          event.preventDefault();
          setDraggingOver(true);
        }}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes(GARMENT_DRAG_MIME) && ![...event.dataTransfer.types].includes("text/plain")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDraggingOver(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setDraggingOver(false);
        }}
        onDrop={acceptDrop}
      >
        <div className="outfit-composer-main">
          <div className="outfit-composer-tray">
            {!ordered.length ? (
              <p className="outfit-composer-empty">Drag garments here to build an outfit</p>
            ) : (
              <div className="outfit-composer-items" role="list">
                {ordered.map((item, index) => (
                  <div className="outfit-composer-slot" key={item.id} role="listitem">
                    {index > 0 && (
                      <span className="outfit-composer-plus" aria-hidden="true">
                        <Plus size={14} weight="bold" />
                      </span>
                    )}
                    <div className="outfit-composer-chip">
                      <OptimizedImage
                        src={item.thumbnail || item.image}
                        alt=""
                        sizes="128px"
                        breakpoints={[96, 128, 160, 256]}
                      />
                      <button
                        type="button"
                        className="outfit-composer-remove"
                        onClick={() => onRemove(item.id)}
                        aria-label={`Remove ${item.name || TYPE_MAP[item.part]?.singular || "garment"}`}
                      >
                        <X size={12} weight="bold" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {ordered.length > 0 && (
          <div className="outfit-composer-actions">
            {ordered.length < 2 ? (
              <p className="outfit-composer-hint">Add at least one more garment</p>
            ) : (
              <>
                <label className="outfit-composer-prompt">
                  <span className="outfit-composer-prompt-label">Details (optional)</span>
                  <input
                    type="text"
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    placeholder="e.g. tucked shirt, evening street"
                    maxLength={1200}
                  />
                </label>
                <button
                  className="outfit-generate-button"
                  type="button"
                  disabled={!canGenerate}
                  onClick={onGenerate}
                >
                  <Sparkle size={15} weight="fill" aria-hidden="true" />
                  <span>Generate</span>
                </button>
              </>
            )}
          </div>
        )}
      </section>
      {error && <p className="outfit-composer-error" role="alert">{error}</p>}
    </div>
  );
}

const OutfitsSection = memo(function OutfitsSection({ outfits, selectedId, onOpen }) {
  const visible = outfits.filter((outfit) => outfit.status !== "processing");
  if (!visible.length) return null;

  return (
    <section className="outfits-section" aria-label="Outfits">
      <div className="outfits-grid">
        {visible.map((outfit) => {
          const canOpen = outfit.status === "ready" || outfit.status === "failed";
          return (
            <button
              key={outfit.id}
              type="button"
              className={`outfit-card${outfit.status === "failed" ? " is-failed" : ""}${selectedId === outfit.id ? " selected" : ""}`}
              data-testid={`outfit-${outfit.id}`}
              onClick={() => canOpen && onOpen(outfit.id)}
              disabled={!canOpen}
              aria-label={`View ${outfit.name || "outfit"}`}
              aria-pressed={selectedId === outfit.id}
            >
              {outfit.status === "ready" && outfit.image ? (
                <OptimizedImage
                  src={outfit.image}
                  alt=""
                  draggable={false}
                  sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 220px"
                  breakpoints={[160, 220, 320, 440]}
                />
              ) : (
                <div className="outfit-card-placeholder" role="status">
                  <span>{outfit.error || "Generation failed"}</span>
                </div>
              )}
              {outfit.name && <p className="outfit-card-name">{outfit.name}</p>}
            </button>
          );
        })}
      </div>
    </section>
  );
});

const GarmentsPanel = memo(function GarmentsPanel({
  loading,
  error,
  itemsLength,
  galleryItems,
  visibleItemIds,
  visibleCount,
  selectedId,
  onOpen,
  activeType,
  searching,
}) {
  const emptyFilterMessage = (() => {
    if (searching) return "No garments match this search.";
    if (activeType === "not_owned") return "No unowned garments.";
    return "No garments in this category.";
  })();

  return (
    <>
      {!error && loading && <GallerySkeleton />}
      {!error && !loading && !itemsLength && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}
      {!error && !loading && !!itemsLength && !visibleCount && (
        <p className="status empty">{emptyFilterMessage}</p>
      )}
      {!loading && !!galleryItems.length && (
        <section
          className="gallery-grid"
          aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}
          hidden={!visibleCount}
        >
          {galleryItems.map((item) => (
            <GalleryItem
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              hidden={!visibleItemIds.has(item.id)}
              onOpen={onOpen}
            />
          ))}
        </section>
      )}
    </>
  );
});

const OutfitsPanel = memo(function OutfitsPanel({
  error,
  listedCount,
  totalCount,
  searching,
  outfits,
  selectedId,
  onOpen,
}) {
  return (
    <>
      {!error && !listedCount && (
        <p className="status empty">
          {searching
            ? "No outfits match this search."
            : totalCount
              ? "No outfits to show."
              : "Generate an outfit from the composer to build your first look."}
        </p>
      )}
      {!error && !!listedCount && (
        <OutfitsSection outfits={outfits} selectedId={selectedId} onOpen={onOpen} />
      )}
    </>
  );
});

function OutfitViewer({ outfit, garments, onClose, onDelete, onSave, onOpenGarment, onNavigate, canPrev, canNext }) {
  const closeButtonRef = useRef(null);
  const [name, setName] = useState(outfit.name || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [zoomImage, setZoomImage] = useState(null);
  const hasImage = outfit.status === "ready" && Boolean(outfit.image);
  const orderedGarments = sortByPart(garments);
  const isDirty = name.trim() !== (outfit.name || "").trim();

  useEffect(() => {
    setName(outfit.name || "");
    setSaveError("");
    setZoomImage((current) => {
      if (!current) return null;
      if (outfit.status === "ready" && outfit.image) {
        return { kind: "outfit", src: outfit.image, alt: outfit.name || "Outfit" };
      }
      return null;
    });
  }, [outfit.id]);

  const persistName = useCallback(async () => {
    const nextName = name.trim();
    if (!nextName) {
      setSaveError("Outfit name cannot be empty.");
      setName(outfit.name || "");
      return false;
    }
    if (nextName === (outfit.name || "").trim()) return true;
    setSaving(true);
    setSaveError("");
    try {
      await onSave(outfit.id, nextName);
      return true;
    } catch (error) {
      setSaveError(error.message || "Could not save the outfit name.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [name, onSave, outfit.id, outfit.name]);

  useEffect(() => {
    if (!isDirty) return undefined;
    const timer = setTimeout(() => {
      void persistName();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [isDirty, name, persistName]);

  const flushAndRun = useCallback(async (action) => {
    if (isDirty) await persistName();
    action?.();
  }, [isDirty, persistName]);

  const requestClose = useCallback(() => {
    void flushAndRun(onClose);
  }, [flushAndRun, onClose]);

  const requestNavigate = useCallback((delta) => {
    if (!onNavigate) return;
    if ((delta < 0 && !canPrev) || (delta > 0 && !canNext)) return;
    void flushAndRun(() => onNavigate(delta));
  }, [canNext, canPrev, flushAndRun, onNavigate]);

  useEffect(() => {
    const unlock = lockBodyScroll();
    closeButtonRef.current?.focus({ preventScroll: true });
    return unlock;
  }, [outfit.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (zoomImage) return;
      if (event.key === "Escape") {
        if (isTypingTarget(event.target)) {
          event.target.blur();
          return;
        }
        requestClose();
        return;
      }
      if (isTypingTarget(event.target)) return;
      const delta = arrowNavigationDelta(event.key);
      if (!delta) return;
      event.preventDefault();
      requestNavigate(delta);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requestClose, requestNavigate, zoomImage]);

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="viewer-entry">
        <aside
          className={`viewer editing${hasImage ? " has-modeled-image has-outfit-image" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label="Selected outfit"
        >
          <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <ViewerNavArrows onNavigate={requestNavigate} label="outfit" canPrev={canPrev} canNext={canNext} />

          {hasImage ? (
            <button
              className="modeled-hero outfit-hero image-zoom-trigger"
              type="button"
              onClick={() => setZoomImage({ kind: "outfit", src: outfit.image, alt: name.trim() || outfit.name || "Outfit" })}
              aria-label="View larger outfit photo"
            >
              <OptimizedImage
                className="modeled-hero-photo"
                src={outfit.image}
                alt={name.trim() || outfit.name || "Outfit"}
                draggable={false}
                sizes="(max-width: 860px) 100vw, 520px"
                breakpoints={[320, 480, 640, 800, 1040, 1280]}
                quality={82}
                priority
              />
            </button>
          ) : (
            <div className="viewer-heading">
              <div className="viewer-heading-title">
                <h2>{name.trim() || "Outfit"}</h2>
                <GenerationCostMeta singleCost={outfit.cost} />
              </div>
            </div>
          )}

          <div className="viewer-details editing">
            {hasImage && (
              <div className="viewer-heading modeled-heading">
                <div className="viewer-heading-title">
                  <h2>{name.trim() || "Outfit"}</h2>
                  <GenerationCostMeta singleCost={outfit.cost} />
                </div>
              </div>
            )}

            <label className="field outfit-name-field">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Outfit"
                maxLength={120}
              />
            </label>

            {outfit.status === "failed" && (
              <p className="outfit-viewer-error" role="alert">{outfit.error || "Generation failed"}</p>
            )}

            {outfit.prompt && (
              <p className="outfit-viewer-prompt">
                <span>Details</span>
                {outfit.prompt}
              </p>
            )}

            <div className="outfit-viewer-garments">
              <p className="details-label">Garments used</p>
              {orderedGarments.length ? (
                <div className="outfit-viewer-garment-list" role="list">
                  {orderedGarments.map((item) => {
                    const type = TYPE_MAP[item.part]?.singular || "Garment";
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="outfit-viewer-garment"
                        role="listitem"
                        onClick={() => {
                          void flushAndRun(() => onOpenGarment(item.id));
                        }}
                        aria-label={`View ${item.name || type}`}
                      >
                        <div className="viewer-art">
                          <OptimizedImage
                            src={item.thumbnail || item.image}
                            alt=""
                            draggable={false}
                            sizes="120px"
                            breakpoints={[96, 120, 160, 240]}
                          />
                        </div>
                        <span className="outfit-viewer-garment-meta">
                          <span className="outfit-viewer-garment-type">{type}</span>
                          <span className="outfit-viewer-garment-name">{item.name || type}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="outfit-viewer-missing">Some garments from this outfit are no longer in the wardrobe.</p>
              )}
            </div>

            {saveError && <p className="outfit-viewer-error" role="alert">{saveError}</p>}
            {saving && !saveError && <p className="autosave-notice" role="status">Saving…</p>}

            <div className="viewer-actions">
              <button className="delete-button" type="button" onClick={() => onDelete(outfit.id)}>
                <Trash size={15} weight="regular" aria-hidden="true" /> Delete
              </button>
            </div>
          </div>
        </aside>
      </div>
      {zoomImage && (
        <ImageZoomLightbox
          src={zoomImage.src}
          alt={zoomImage.alt}
          onClose={() => setZoomImage(null)}
          onNavigate={requestNavigate}
          canPrev={canPrev}
          canNext={canNext}
          label="outfit"
        />
      )}
    </div>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>No distinct secondary color detected.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary color</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Selected</small>
          <strong>{value || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>Image suggestions</span>
        <small>Click to apply</small>
      </div>
      <div className="palette" aria-label={`${label} suggestions from image`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel picking" : `Pick ${label.toLowerCase()} from image`}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="ownership-toggle">
        <input
          type="checkbox"
          checked={!draft.owned}
          onChange={(event) => setDraft((current) => ({ ...current, owned: !event.target.checked }))}
        />
        <span className="ownership-toggle__mark" aria-hidden="true">
          <BookmarkSimple size={14} weight={draft.owned ? "regular" : "fill"} />
        </span>
        <span className="ownership-toggle__copy">
          <span className="ownership-toggle__title">Not owned</span>
          <span className="ownership-toggle__hint">Mark pieces you want but don’t have yet</span>
        </span>
      </label>

      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {PART_TYPES.map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>Colors</legend>
        <div className="colors-editor">
          <ColorControl
            label="Primary color"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="Secondary color"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `Click anywhere on the garment to sample the ${sampling} color.` : sampleStatus || "Primary colors come from the image. A secondary is suggested only when a distinct color has meaningful coverage."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete, onGenerateModeled, onBackToOutfit, onNavigate, canPrev, canNext }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], owned: isOwned(item) });
  const [refreshingGeneration, setRefreshingGeneration] = useState(false);
  const [confirmKind, setConfirmKind] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [zoomImage, setZoomImage] = useState(null);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);
  const modeledStatus = item.modeledGeneration?.status || null;
  const modeledBusy = modeledStatus === "processing";
  const modeledError = modeledStatus === "failed" ? item.modeledGeneration.error : "";
  const garmentStatus = item.garmentGeneration?.status || null;
  const garmentBusy = garmentStatus === "processing";
  const garmentError = garmentStatus === "failed" ? item.garmentGeneration.error : "";
  const generationBusy = modeledBusy || garmentBusy;
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
      owned: draft.owned !== false,
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
      owned: isOwned(item),
    });
  }, [draft, item]);

  const persistDraft = useCallback(() => {
    onSave({
      ...item,
      ...draft,
      name: draft.name.trim(),
      tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
      owned: draft.owned !== false,
    });
  }, [draft, item, onSave]);

  useEffect(() => {
    if (!isDirty) return undefined;
    const timer = setTimeout(() => {
      persistDraft();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft, isDirty, persistDraft]);

  const flushAndRun = useCallback((action) => {
    if (isDirty) persistDraft();
    action?.();
  }, [isDirty, persistDraft]);

  const requestClose = useCallback(() => {
    flushAndRun(onClose);
  }, [flushAndRun, onClose]);

  const requestBack = useCallback(() => {
    if (!onBackToOutfit) return;
    flushAndRun(onBackToOutfit);
  }, [flushAndRun, onBackToOutfit]);

  const requestNavigate = useCallback((delta) => {
    if (!onNavigate) return;
    if ((delta < 0 && !canPrev) || (delta > 0 && !canNext)) return;
    flushAndRun(() => onNavigate(delta));
  }, [canNext, canPrev, flushAndRun, onNavigate]);

  useEffect(() => {
    const unlock = lockBodyScroll();
    closeButtonRef.current?.focus({ preventScroll: true });
    return unlock;
  }, [item.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (zoomImage) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") {
        if (confirmKind) {
          setConfirmKind(null);
          setRegenPrompt("");
        } else if (sampling) setSampling(null);
        else if (onBackToOutfit) requestBack();
        else requestClose();
        return;
      }
      if (confirmKind) return;
      const delta = arrowNavigationDelta(event.key);
      if (!delta) return;
      event.preventDefault();
      requestNavigate(delta);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmKind, onBackToOutfit, requestBack, requestClose, requestNavigate, sampling, zoomImage]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], owned: isOwned(item) });
    setRefreshingGeneration(false);
    setConfirmKind(null);
    setRegenPrompt("");
    setZoomImage((current) => {
      if (!current) return null;
      const nextType = TYPE_MAP[item.part]?.singular || "Wardrobe item";
      const nextName = item.name || nextType;
      if (current.kind === "modeled" && item.modeledImage) {
        return { kind: "modeled", src: item.modeledImage, alt: `${nextName} worn by a model` };
      }
      if (item.image) {
        return { kind: "garment", src: item.image, alt: nextName };
      }
      if (item.modeledImage) {
        return { kind: "modeled", src: item.modeledImage, alt: `${nextName} worn by a model` };
      }
      return null;
    });
    // Intentionally keyed on the item's identity, not the whole object—unrelated
    // patches to the same item (e.g. modeled-photo status updates) shouldn't
    // wipe in-progress edits or the extracted color suggestions.
  }, [item.id]);

  const generateModeledPhoto = async (prompt = "") => {
    try {
      const response = await fetch(`/api/import/wardrobe/${item.id}/modeled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prompt ? { prompt } : {}),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "Could not generate a modeled photo.");
      onGenerateModeled(item.id, {
        modeledImage: value.modeledImage,
        modeledGeneration: value.modeledGeneration ?? null,
        costs: value.costs ?? item.costs,
      });
    } catch (requestError) {
      onGenerateModeled(item.id, { modeledGeneration: { status: "failed", error: requestError.message } });
    }
  };

  const generateGarmentPhoto = async (prompt = "") => {
    try {
      const response = await fetch(`/api/import/wardrobe/${item.id}/garment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prompt ? { prompt } : {}),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "Could not regenerate the garment.");
      onGenerateModeled(item.id, {
        image: value.image ?? item.image,
        thumbnail: value.thumbnail ?? value.image ?? item.thumbnail,
        garmentGeneration: value.garmentGeneration ?? null,
        costs: value.costs ?? item.costs,
      });
    } catch (requestError) {
      onGenerateModeled(item.id, { garmentGeneration: { status: "failed", error: requestError.message } });
    }
  };

  const openConfirm = (kind) => {
    setRegenPrompt("");
    setConfirmKind(kind);
  };

  const closeConfirm = () => {
    setConfirmKind(null);
    setRegenPrompt("");
  };

  const confirmRegenerateAction = async () => {
    const prompt = regenPrompt.trim();
    const kind = confirmKind;
    closeConfirm();
    if (kind === "garment") await generateGarmentPhoto(prompt);
    else if (kind === "modeled") await generateModeledPhoto(prompt);
  };

  const refreshGenerationStatus = async () => {
    setRefreshingGeneration(true);
    try {
      const response = await fetch(`/api/import/wardrobe/${item.id}`, { cache: "no-store" });
      const value = await response.json().catch(() => ({}));
      if (response.ok) {
        onGenerateModeled(item.id, {
          image: value.image ?? item.image,
          thumbnail: value.thumbnail ?? item.thumbnail,
          modeledImage: value.modeledImage,
          modeledGeneration: value.modeledGeneration ?? null,
          garmentGeneration: value.garmentGeneration ?? null,
          costs: value.costs ?? item.costs,
        });
      }
    } catch {
      // Transient network hiccups shouldn't surface as an error—just try again later.
    } finally {
      setRefreshingGeneration(false);
    }
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (sampling && samplingCanvasRef.current) {
      const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
      if (!color) {
        setSampleStatus("That spot is transparent—try directly on the garment.");
        return;
      }
      const targetField = sampling === "secondary" ? "secondaryColor" : "color";
      setDraft((current) => ({ ...current, [targetField]: color }));
      setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
      setSampleStatus(`Sampled ${color} as the ${sampling} color.`);
      setSampling(null);
      return;
    }
    setZoomImage({ kind: "garment", src: item.image, alt: draft.name || type });
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : " image-zoom-trigger"}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        draggable={false}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Click garment to sample</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
      {onBackToOutfit && (
        <button className="viewer-back-button" type="button" onClick={requestBack}>
          <ArrowLeft size={16} weight="bold" aria-hidden="true" />
          Back to outfit
        </button>
      )}
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>
      <ViewerNavArrows onNavigate={requestNavigate} label="garment" canPrev={canPrev} canNext={canNext} />

      {hasModeledImage ? (
        <div className="modeled-hero">
          <button
            className="modeled-hero-zoom image-zoom-trigger"
            type="button"
            onClick={() => setZoomImage({ kind: "modeled", src: item.modeledImage, alt: `${draft.name || type} worn by a model` })}
            aria-label="View larger modeled photo"
          >
            <OptimizedImage
              className="modeled-hero-photo"
              src={item.modeledImage}
              alt={`${draft.name || type} worn by a model`}
              draggable={false}
              sizes="(max-width: 860px) 100vw, 520px"
              breakpoints={[320, 480, 640, 800, 1040, 1280]}
              quality={82}
              priority
            />
          </button>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className={`viewer-heading${onBackToOutfit ? " has-back" : ""}`}>
            <div className="viewer-heading-title">
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
              <GenerationCostMeta costs={item.costs} />
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="modeled-photo-control">
        <div className="modeled-photo-row">
          {generationBusy ? (
            <button className="secondary-button modeled-photo-refresh" type="button" onClick={refreshGenerationStatus} disabled={refreshingGeneration}>
              {refreshingGeneration ? <SpinnerGap size={15} weight="bold" className="import-spinner" aria-hidden="true" /> : <ArrowClockwise size={15} weight="regular" aria-hidden="true" />}
              {refreshingGeneration
                ? "Checking…"
                : garmentBusy && modeledBusy
                  ? "Check status"
                  : garmentBusy
                    ? "Check garment status"
                    : "Check modeled status"}
            </button>
          ) : (
            <>
              <button className="secondary-button modeled-photo-button" type="button" onClick={() => openConfirm("garment")} disabled={garmentBusy}>
                <ArrowClockwise size={15} weight="regular" aria-hidden="true" />
                Regenerate garment
              </button>
              <button className="secondary-button modeled-photo-button" type="button" onClick={() => openConfirm("modeled")}>
                <Sparkle size={15} weight="regular" aria-hidden="true" />
                {hasModeledImage ? "Regenerate modeled photo" : "Generate modeled photo"}
              </button>
            </>
          )}
        </div>
        {garmentBusy && <p className="modeled-photo-status" role="status">Regenerating the garment in the background—this can take up to a minute.</p>}
        {modeledBusy && <p className="modeled-photo-status" role="status">Generating the modeled photo in the background—this can take up to a minute.</p>}
        {garmentError && <p className="modeled-photo-error" role="alert">{garmentError}</p>}
        {modeledError && <p className="modeled-photo-error" role="alert">{modeledError}</p>}
      </div>

      {confirmKind && (
        <div
          className="confirm-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeConfirm();
          }}
        >
          <section
            className="confirm-modal confirm-modal--regen"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="regenerate-look-title"
            aria-describedby="regenerate-look-detail"
          >
            <p className="confirm-modal-eyebrow">{confirmKind === "garment" ? "Garment image" : "Modeled photo"}</p>
            <h3 className="confirm-modal-title" id="regenerate-look-title">
              {confirmKind === "garment"
                ? "Regenerate this garment?"
                : hasModeledImage
                  ? "Regenerate this look?"
                  : "Generate a modeled photo?"}
            </h3>
            <p className="confirm-modal-detail" id="regenerate-look-detail">
              {confirmKind === "garment"
                ? "A new garment cutout will replace the current one. This can take up to a minute."
                : hasModeledImage
                  ? "A new modeled photo will replace the current one. This can take up to a minute."
                  : "This can take up to a minute. You can keep browsing while it runs."}
            </p>
            <label className="confirm-modal-prompt">
              <span>Direction <em>optional</em></span>
              <textarea
                rows={3}
                value={regenPrompt}
                onChange={(event) => setRegenPrompt(event.target.value)}
                maxLength={1200}
                placeholder={
                  confirmKind === "garment"
                    ? "e.g. preserve the original zipper and remove the retail tag"
                    : "e.g. quiet evening street, show the full garment"
                }
              />
            </label>
            <div className="confirm-modal-actions">
              <button className="secondary-button" type="button" onClick={closeConfirm}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={confirmRegenerateAction}>
                {confirmKind === "garment" ? (
                  <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
                ) : (
                  <Sparkle size={15} weight="fill" aria-hidden="true" />
                )}
                {confirmKind === "garment" || hasModeledImage ? "Regenerate" : "Generate"}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="viewer-details editing">
        {hasModeledImage && (
          <div className="viewer-heading modeled-heading">
            <div className="viewer-heading-title">
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
              <GenerationCostMeta costs={item.costs} />
            </div>
          </div>
        )}

        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> Delete
          </button>
        </div>
      </div>
    </aside>
    </div>
      {zoomImage && (
        <ImageZoomLightbox
          src={zoomImage.src}
          alt={zoomImage.alt}
          onClose={() => setZoomImage(null)}
          onNavigate={requestNavigate}
          canPrev={canPrev}
          canNext={canNext}
          label="garment"
        />
      )}
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [libraryTab, setLibraryTab] = useState("garments");
  const [activeType, setActiveType] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [composerItems, setComposerItems] = useState([]);
  const [composerPrompt, setComposerPrompt] = useState("");
  const [composerError, setComposerError] = useState("");
  const [outfits, setOutfits] = useState([]);
  const [selectedOutfitId, setSelectedOutfitId] = useState(null);
  const [returnOutfitId, setReturnOutfitId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    fetch("/api/import/wardrobe", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the wardrobe.");
        return response.json();
      })
      .then((loadedItems) => {
        const edits = readEdits();
        const deleted = readDeletedItems();
        const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
        setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/import/outfits", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load outfits.");
        return response.json();
      })
      .then((loadedOutfits) => setOutfits(Array.isArray(loadedOutfits) ? loadedOutfits : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!outfits.some((outfit) => outfit.status === "processing")) return undefined;
    const timer = setInterval(() => {
      fetch("/api/import/outfits", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((loadedOutfits) => {
          if (!Array.isArray(loadedOutfits)) return;
          setOutfits(loadedOutfits);
        })
        .catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [outfits]);

  const processingGenerationIds = items
    .filter((item) => item.modeledGeneration?.status === "processing" || item.garmentGeneration?.status === "processing")
    .map((item) => item.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!processingGenerationIds) return undefined;
    const ids = processingGenerationIds.split(",");
    const timer = setInterval(() => {
      Promise.all(
        ids.map((id) =>
          fetch(`/api/import/wardrobe/${id}`, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null)
        )
      ).then((records) => {
        setItems((current) => {
          let changed = false;
          const next = current.map((item) => {
            const record = records.find((entry) => entry?.id === item.id);
            if (!record) return item;
            if (
              record.image === item.image
              && record.thumbnail === item.thumbnail
              && record.modeledImage === item.modeledImage
              && JSON.stringify(record.modeledGeneration ?? null) === JSON.stringify(item.modeledGeneration ?? null)
              && JSON.stringify(record.garmentGeneration ?? null) === JSON.stringify(item.garmentGeneration ?? null)
              && JSON.stringify(record.costs ?? null) === JSON.stringify(item.costs ?? null)
            ) {
              return item;
            }
            changed = true;
            return {
              ...item,
              image: record.image ?? item.image,
              thumbnail: record.thumbnail ?? item.thumbnail,
              modeledImage: record.modeledImage ?? item.modeledImage,
              modeledGeneration: record.modeledGeneration ?? null,
              garmentGeneration: record.garmentGeneration ?? null,
              costs: record.costs ?? item.costs,
            };
          });
          return changed ? next : current;
        });
      });
    }, 1200);
    return () => clearInterval(timer);
  }, [processingGenerationIds]);

  const selectedItem = items.find((item) => item.id === selectedId) || null;
  const selectedOutfit = outfits.find((outfit) => outfit.id === selectedOutfitId) || null;
  const selectedOutfitGarments = useMemo(() => {
    if (!selectedOutfit) return [];
    return (selectedOutfit.garmentIds || [])
      .map((id) => items.find((item) => item.id === id))
      .filter(Boolean);
  }, [items, selectedOutfit]);

  const openItem = useCallback((id) => {
    setLibraryTab((current) => (current === "garments" ? current : "garments"));
    setReturnOutfitId(null);
    setSelectedOutfitId(null);
    setSelectedId(id);
  }, []);

  const openOutfit = useCallback((id) => {
    setLibraryTab((current) => (current === "outfits" ? current : "outfits"));
    setReturnOutfitId(null);
    setSelectedId(null);
    setSelectedOutfitId(id);
  }, []);

  const chooseLibraryTab = useCallback((tab) => {
    setLibraryTab((current) => (current === tab ? current : tab));
  }, []);

  const openGarmentFromOutfit = useCallback((garmentId) => {
    setReturnOutfitId(selectedOutfitId);
    setSelectedOutfitId(null);
    setSelectedId(garmentId);
  }, [selectedOutfitId]);

  const backToOutfit = useCallback(() => {
    if (!returnOutfitId) return;
    setLibraryTab((current) => (current === "outfits" ? current : "outfits"));
    setSelectedId(null);
    setSelectedOutfitId(returnOutfitId);
    setReturnOutfitId(null);
  }, [returnOutfitId]);

  const closeItemViewer = useCallback(() => {
    setSelectedId(null);
    setReturnOutfitId(null);
  }, []);

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const garmentFuse = useMemo(() => {
    const docs = items.map((item) => ({
      id: item.id,
      name: item.name || "",
      tags: item.tags || [],
      typeLabel: TYPE_MAP[item.part]?.label || "",
      typeSingular: TYPE_MAP[item.part]?.singular || "",
    }));
    return new Fuse(docs, GARMENT_FUSE_OPTIONS);
  }, [items]);

  const outfitFuse = useMemo(() => {
    const docs = outfits.map((outfit) => {
      const garments = (outfit.garmentIds || []).map((id) => itemsById.get(id)).filter(Boolean);
      return {
        id: outfit.id,
        name: outfit.name || "",
        prompt: outfit.prompt || "",
        setting: outfit.setting || "",
        garmentNames: garments.map((garment) => garment.name).filter(Boolean),
        garmentTags: garments.flatMap((garment) => garment.tags || []),
      };
    });
    return new Fuse(docs, OUTFIT_FUSE_OPTIONS);
  }, [itemsById, outfits]);

  const sortedGalleryItems = useMemo(() => (
    [...items].sort((a, b) => {
      const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
      if (typeDifference) return typeDifference;
      return a.id.localeCompare(b.id);
    })
  ), [items]);

  const visibleItems = useMemo(() => {
    const matchesFilter = (item) => {
      if (activeType === "all") return true;
      if (activeType === "not_owned") return !isOwned(item);
      return item.part === activeType;
    };

    if (deferredSearchQuery) {
      return garmentFuse
        .search(deferredSearchQuery)
        .map((result) => itemsById.get(result.item.id))
        .filter((item) => item && matchesFilter(item));
    }

    return sortedGalleryItems.filter(matchesFilter);
  }, [activeType, deferredSearchQuery, garmentFuse, itemsById, sortedGalleryItems]);

  const visibleItemIds = useMemo(
    () => new Set(visibleItems.map((item) => item.id)),
    [visibleItems],
  );

  // Keep the full sorted grid mounted while browsing filters so switching back to
  // All does not remount images. Search uses the ranked subset instead.
  const galleryItems = deferredSearchQuery ? visibleItems : sortedGalleryItems;

  const visibleOutfits = useMemo(() => {
    if (deferredSearchQuery) {
      const rankedIds = outfitFuse.search(deferredSearchQuery).map((result) => result.item.id);
      const rank = new Map(rankedIds.map((id, index) => [id, index]));
      return outfits
        .filter((outfit) => rank.has(outfit.id))
        .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    }

    return outfits;
  }, [deferredSearchQuery, outfitFuse, outfits]);

  const listedOutfits = useMemo(
    () => visibleOutfits.filter((outfit) => outfit.status !== "processing"),
    [visibleOutfits],
  );

  const totalOutfitCount = useMemo(
    () => outfits.filter((outfit) => outfit.status !== "processing").length,
    [outfits],
  );

  const garmentMatchCount = useMemo(() => {
    if (!deferredSearchQuery) return null;
    return garmentFuse.search(deferredSearchQuery).length;
  }, [deferredSearchQuery, garmentFuse]);

  const outfitMatchCount = useMemo(() => {
    if (!deferredSearchQuery) return null;
    return listedOutfits.length;
  }, [deferredSearchQuery, listedOutfits.length]);

  const browseableOutfitIds = useMemo(
    () => visibleOutfits.filter((outfit) => outfit.status === "ready" || outfit.status === "failed").map((outfit) => outfit.id),
    [visibleOutfits],
  );

  const navigableItemIds = useMemo(() => {
    const sourceOutfit = returnOutfitId ? outfits.find((outfit) => outfit.id === returnOutfitId) : null;
    if (sourceOutfit) {
      return sortByPart(
        (sourceOutfit.garmentIds || [])
          .map((id) => items.find((item) => item.id === id))
          .filter(Boolean),
      ).map((item) => item.id);
    }
    return visibleItems.map((item) => item.id);
  }, [items, outfits, returnOutfitId, visibleItems]);

  const itemNavBounds = useMemo(
    () => navigationBounds(navigableItemIds, selectedId),
    [navigableItemIds, selectedId],
  );

  const outfitNavBounds = useMemo(
    () => navigationBounds(browseableOutfitIds, selectedOutfitId),
    [browseableOutfitIds, selectedOutfitId],
  );

  const navigateItem = useCallback((delta) => {
    const nextId = adjacentId(navigableItemIds, selectedId, delta);
    if (nextId && nextId !== selectedId) setSelectedId(nextId);
  }, [navigableItemIds, selectedId]);

  const navigateOutfit = useCallback((delta) => {
    const nextId = adjacentId(browseableOutfitIds, selectedOutfitId, delta);
    if (nextId && nextId !== selectedOutfitId) setSelectedOutfitId(nextId);
  }, [browseableOutfitIds, selectedOutfitId]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
    setSelectedOutfitId(null);
    setReturnOutfitId(null);
  };

  const deleteOutfit = useCallback(async (id) => {
    try {
      const response = await fetch(`/api/import/outfits/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("Could not delete the outfit.");
    } catch (requestError) {
      setError(requestError.message);
      throw requestError;
    }
    setOutfits((current) => current.filter((outfit) => outfit.id !== id));
    setSelectedOutfitId(null);
  }, []);

  const saveOutfitName = useCallback(async (id, name) => {
    const response = await fetch(`/api/import/outfits/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not save the outfit name.");
    setOutfits((current) => current.map((outfit) => (outfit.id === id ? { ...outfit, ...result } : outfit)));
  }, []);

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
  };

  const deleteItem = useCallback(async (id) => {
    if (id.startsWith("import-")) {
      try {
        const response = await fetch(`/api/import/wardrobe/${id}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error("Could not delete the imported item.");
      } catch (requestError) {
        setError(requestError.message);
        throw requestError;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    setComposerItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
    setReturnOutfitId(null);
  }, []);

  const requestDeleteItem = useCallback((id) => {
    const item = items.find((entry) => entry.id === id);
    setDeleteConfirm({
      kind: "item",
      id,
      eyebrow: "Garment",
      title: `Delete ${item?.name || "this garment"}?`,
      detail: "It will be removed from your wardrobe. This can’t be undone.",
    });
  }, [items]);

  const requestDeleteOutfit = useCallback((id) => {
    const outfit = outfits.find((entry) => entry.id === id);
    setDeleteConfirm({
      kind: "outfit",
      id,
      eyebrow: "Outfit",
      title: `Delete ${outfit?.name || "this outfit"}?`,
      detail: "The look will be removed. The garments in your wardrobe stay.",
      confirmLabel: outfit?.status === "processing" ? "Cancel generation" : "Delete",
    });
  }, [outfits]);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm || deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (deleteConfirm.kind === "outfit") await deleteOutfit(deleteConfirm.id);
      else await deleteItem(deleteConfirm.id);
      setDeleteConfirm(null);
    } catch {
      // Errors are surfaced via setError inside the delete helpers.
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deleteConfirm, deleteItem, deleteOutfit]);

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => {
      if (current.some((item) => item.id === newItem.id)) {
        return current.map((item) => (item.id === newItem.id ? { ...item, ...newItem } : item));
      }
      return [...current, newItem];
    });
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage, costs) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => (
      item.id === id
        ? {
          ...item,
          modeledImage,
          ...(costs ? { costs: { ...(item.costs || {}), ...costs } } : {}),
        }
        : item
    )));
  }, []);

  const patchItem = useCallback((id, patch) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const addToComposer = useCallback((id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    let nextError = "";
    setComposerItems((current) => {
      if (current.some((entry) => entry.id === item.id)) {
        nextError = "";
        return current;
      }
      const allowsMultiple = item.part === "accessories_up";
      if (!allowsMultiple && current.some((entry) => entry.part === item.part)) {
        nextError = `Only one ${TYPE_MAP[item.part]?.singular || "item"} can be added.`;
        return current;
      }
      nextError = "";
      return [...current, item];
    });
    setComposerError(nextError);
  }, [items]);

  const removeFromComposer = useCallback((id) => {
    setComposerError("");
    setComposerItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const generateOutfit = useCallback(async () => {
    if (composerItems.length < 2) return;
    const snapshotItems = composerItems;
    const garmentIds = snapshotItems.map((item) => item.id);
    const prompt = composerPrompt.trim();
    setComposerError("");
    setComposerItems([]);
    setComposerPrompt("");
    try {
      const response = await fetch("/api/import/outfits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentIds, prompt }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not generate the outfit.");
      setOutfits((current) => [result, ...current.filter((outfit) => outfit.id !== result.id)]);
    } catch (requestError) {
      setComposerItems(snapshotItems);
      setComposerPrompt(prompt);
      setComposerError(requestError.message);
    }
  }, [composerItems, composerPrompt]);

  return (
    <div className={`app-shell${selectedItem || selectedOutfit ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <div className="gallery-toolbar">
          <OutfitComposer
            items={composerItems}
            prompt={composerPrompt}
            onPromptChange={setComposerPrompt}
            error={composerError}
            onAdd={addToComposer}
            onRemove={removeFromComposer}
            onGenerate={generateOutfit}
          />
          <GallerySearch
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={libraryTab === "outfits" ? "Search outfits" : "Search garments"}
            label={libraryTab === "outfits" ? "Search outfits" : "Search garments"}
          />
        </div>

        <header className="gallery-header">
          <div className="gallery-meta-row">
            <nav className="library-tabs" aria-label="Library">
              <button
                type="button"
                className={libraryTab === "garments" ? "active" : ""}
                onClick={() => chooseLibraryTab("garments")}
                aria-pressed={libraryTab === "garments"}
                aria-label={
                  garmentMatchCount == null
                    ? "Garments"
                    : `Garments, ${garmentMatchCount} ${garmentMatchCount === 1 ? "match" : "matches"}`
                }
              >
                Garments
                {garmentMatchCount != null && (
                  <span className="library-tab-badge" aria-hidden="true">
                    {garmentMatchCount > 99 ? "99+" : garmentMatchCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={libraryTab === "outfits" ? "active" : ""}
                onClick={() => chooseLibraryTab("outfits")}
                aria-pressed={libraryTab === "outfits"}
                aria-label={
                  outfitMatchCount == null
                    ? "Outfits"
                    : `Outfits, ${outfitMatchCount} ${outfitMatchCount === 1 ? "match" : "matches"}`
                }
              >
                Outfits
                {outfitMatchCount != null && (
                  <span className="library-tab-badge" aria-hidden="true">
                    {outfitMatchCount > 99 ? "99+" : outfitMatchCount}
                  </span>
                )}
              </button>
            </nav>
            {loading && libraryTab === "garments" ? (
              <span className="piece-count-skeleton" aria-hidden="true" />
            ) : (
              <p className="piece-count">
                {libraryTab === "outfits"
                  ? `${totalOutfitCount} ${totalOutfitCount === 1 ? "look" : "looks"}`
                  : `${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
              </p>
            )}
          </div>
          <nav
            className="category-nav"
            aria-label="Filter wardrobe"
            aria-disabled={loading || undefined}
            hidden={libraryTab !== "garments"}
          >
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={`${activeType === type.id ? "active" : ""}${type.icon ? " category-nav-icon" : ""}`}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
                aria-label={type.label}
                disabled={loading}
                tabIndex={libraryTab === "garments" ? undefined : -1}
                title={type.label}
              >
                {type.icon === "bookmark" ? (
                  <BookmarkSimple size={15} weight={activeType === type.id ? "fill" : "regular"} aria-hidden="true" />
                ) : (
                  type.label
                )}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}

        <div className="library-panel" hidden={libraryTab !== "garments"}>
          <GarmentsPanel
            loading={loading}
            error={error}
            itemsLength={items.length}
            galleryItems={galleryItems}
            visibleItemIds={visibleItemIds}
            visibleCount={visibleItems.length}
            selectedId={selectedId}
            onOpen={openItem}
            activeType={activeType}
            searching={Boolean(deferredSearchQuery)}
          />
        </div>

        <div className="library-panel" hidden={libraryTab !== "outfits"}>
          <OutfitsPanel
            error={error}
            listedCount={listedOutfits.length}
            totalCount={totalOutfitCount}
            searching={Boolean(deferredSearchQuery)}
            outfits={visibleOutfits}
            selectedId={selectedOutfitId}
            onOpen={openOutfit}
          />
        </div>
      </main>

      {selectedItem && (
        <ItemViewer
          item={selectedItem}
          onClose={closeItemViewer}
          onSave={saveItem}
          onDelete={requestDeleteItem}
          onGenerateModeled={patchItem}
          onBackToOutfit={returnOutfitId ? backToOutfit : null}
          onNavigate={navigateItem}
          canPrev={itemNavBounds.canPrev}
          canNext={itemNavBounds.canNext}
        />
      )}
      {selectedOutfit && (
        <OutfitViewer
          outfit={selectedOutfit}
          garments={selectedOutfitGarments}
          onClose={() => setSelectedOutfitId(null)}
          onDelete={requestDeleteOutfit}
          onSave={saveOutfitName}
          onOpenGarment={openGarmentFromOutfit}
          onNavigate={navigateOutfit}
          canPrev={outfitNavBounds.canPrev}
          canNext={outfitNavBounds.canNext}
        />
      )}
      <WardrobeImportFlow
        onGarmentApproved={addImportedItem}
        onModeledApproved={attachImportedModeledImage}
        processingOutfits={outfits.filter((outfit) => outfit.status === "processing")}
        processingGarments={items.filter((item) => item.modeledGeneration?.status === "processing" || item.garmentGeneration?.status === "processing")}
        outfits={outfits}
        wardrobeItems={items}
        onDeleteOutfit={requestDeleteOutfit}
        onOpenCompletion={(entry) => {
          if (entry.kind === "outfit") openOutfit(entry.id);
          else openItem(entry.id);
        }}
      />
      {deleteConfirm && (
        <ConfirmDeleteModal
          eyebrow={deleteConfirm.eyebrow}
          title={deleteConfirm.title}
          detail={deleteConfirm.detail}
          confirmLabel={deleteConfirm.confirmLabel}
          busy={deleteBusy}
          elevated={deleteConfirm.kind === "outfit" && !selectedOutfit}
          onCancel={() => {
            if (!deleteBusy) setDeleteConfirm(null);
          }}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
