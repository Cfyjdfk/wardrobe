import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, CaretLeft, CaretRight, Check, MagnifyingGlass, Plus, Sparkle, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import Fuse from "fuse.js";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";
const GARMENT_DRAG_MIME = "application/x-wardrobe-garment";

const TYPES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));

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


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
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

function GalleryItem({ item, selected, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";
  const dragMoved = useRef(false);

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      draggable
      onDragStart={(event) => {
        dragMoved.current = false;
        event.dataTransfer.setData(GARMENT_DRAG_MIME, item.id);
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "copy";
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
      aria-label={`View ${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
    </button>
  );
}

function GallerySearch({ value, onChange }) {
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
        aria-label={expanded ? "Search garments and outfits" : "Open search"}
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
          placeholder="Search name or details"
          aria-label="Search garments and outfits"
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

function OutfitComposer({ items, prompt, onPromptChange, error, generating, onAdd, onRemove, onGenerate }) {
  const [draggingOver, setDraggingOver] = useState(false);
  const ordered = sortByPart(items);
  const canGenerate = ordered.length >= 2 && !generating;

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

          {ordered.length >= 2 && (
            <label className="outfit-composer-prompt">
              <span className="outfit-composer-prompt-label">Details (optional)</span>
              <input
                type="text"
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                placeholder="e.g. tucked shirt, evening street"
                maxLength={1200}
                disabled={generating}
              />
            </label>
          )}
        </div>

        <div className="outfit-composer-actions">
          {ordered.length > 0 && ordered.length < 2 && (
            <p className="outfit-composer-hint">Add at least one more garment</p>
          )}
          {(ordered.length >= 2 || generating) && (
            <button
              className="outfit-generate-button"
              type="button"
              disabled={!canGenerate}
              onClick={onGenerate}
            >
              {generating ? <SpinnerGap size={15} className="import-spinner" aria-hidden="true" /> : <Sparkle size={15} weight="fill" aria-hidden="true" />}
              <span>{generating ? "Generating" : "Generate"}</span>
            </button>
          )}
        </div>
      </section>
      {error && <p className="outfit-composer-error" role="alert">{error}</p>}
    </div>
  );
}

function OutfitsSection({ outfits, selectedId, onOpen }) {
  if (!outfits.length) return null;

  return (
    <section className="outfits-section" aria-label="Outfits">
      <header className="outfits-header">
        <h2 className="outfits-title">Outfits</h2>
        <p className="outfits-count">{outfits.length} {outfits.length === 1 ? "look" : "looks"}</p>
      </header>
      <div className="outfits-grid">
        {outfits.map((outfit) => {
          const canOpen = outfit.status === "ready" || outfit.status === "failed";
          return (
            <button
              key={outfit.id}
              type="button"
              className={`outfit-card${outfit.status === "processing" ? " is-processing" : ""}${outfit.status === "failed" ? " is-failed" : ""}${selectedId === outfit.id ? " selected" : ""}`}
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
                  sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 220px"
                  breakpoints={[160, 220, 320, 440]}
                />
              ) : (
                <div className="outfit-card-placeholder" role="status">
                  {outfit.status === "processing" ? (
                    <>
                      <SpinnerGap size={22} className="import-spinner" aria-hidden="true" />
                      <span>Generating</span>
                    </>
                  ) : (
                    <span>{outfit.error || "Generation failed"}</span>
                  )}
                </div>
              )}
              {outfit.name && <p className="outfit-card-name">{outfit.name}</p>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OutfitViewer({ outfit, garments, onClose, onDelete, onSave, onOpenGarment, onNavigate, canPrev, canNext }) {
  const closeButtonRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [name, setName] = useState(outfit.name || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const hasImage = outfit.status === "ready" && Boolean(outfit.image);
  const orderedGarments = sortByPart(garments);
  const isDirty = name.trim() !== (outfit.name || "").trim();

  useEffect(() => {
    setName(outfit.name || "");
    setSaveError("");
    setCloseBlocked(false);
  }, [outfit.id]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  const requestNavigate = useCallback((delta) => {
    if (!onNavigate) return;
    if ((delta < 0 && !canPrev) || (delta > 0 && !canNext)) return;
    if (isDirty) nudgeUnsaved();
    else onNavigate(delta);
  }, [canNext, canPrev, isDirty, nudgeUnsaved, onNavigate]);

  useEffect(() => {
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [outfit.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (isTypingTarget(event.target) && isDirty) return;
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
  }, [isDirty, requestClose, requestNavigate]);

  const cancelEditing = () => {
    setName(outfit.name || "");
    setSaveError("");
    setCloseBlocked(false);
    onClose();
  };

  const saveEditing = async () => {
    const nextName = name.trim();
    if (!nextName) {
      setSaveError("Outfit name cannot be empty.");
      return;
    }
    if (!isDirty) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSave(outfit.id, nextName);
      setCloseBlocked(false);
    } catch (error) {
      setSaveError(error.message || "Could not save the outfit name.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="viewer-entry">
        <aside
          className={`viewer editing${hasImage ? " has-modeled-image has-outfit-image" : ""}${shaking ? " shake" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label="Selected outfit"
        >
          <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <ViewerNavArrows onNavigate={requestNavigate} label="outfit" canPrev={canPrev} canNext={canNext} />

          {hasImage ? (
            <div className="modeled-hero outfit-hero">
              <OptimizedImage
                className="modeled-hero-photo"
                src={outfit.image}
                alt={name.trim() || outfit.name || "Outfit"}
                sizes="(max-width: 860px) 100vw, 520px"
                breakpoints={[320, 480, 640, 800, 1040, 1280]}
                quality={82}
                priority
              />
            </div>
          ) : (
            <div className="viewer-heading">
              <div>
                <h2>{name.trim() || "Outfit"}</h2>
              </div>
            </div>
          )}

          <div className="viewer-details editing">
            {hasImage && (
              <div className="viewer-heading modeled-heading">
                <div>
                  <h2>{name.trim() || "Outfit"}</h2>
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
                          if (isDirty) nudgeUnsaved();
                          else onOpenGarment(item.id);
                        }}
                        aria-label={`View ${item.name || type}`}
                      >
                        <div className="viewer-art">
                          <OptimizedImage
                            src={item.thumbnail || item.image}
                            alt=""
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

            {closeBlocked && isDirty && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}
            {saveError && <p className="outfit-viewer-error" role="alert">{saveError}</p>}

            <div className="viewer-actions">
              <button className="delete-button" type="button" onClick={() => onDelete(outfit.id)}>
                <Trash size={15} weight="regular" aria-hidden="true" /> Delete
              </button>
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={cancelEditing}>Cancel</button>
              <button className="primary-button" type="button" onClick={saveEditing} disabled={!isDirty || saving}>
                <Check size={15} weight="bold" aria-hidden="true" /> {saving ? "Saving" : "Save"}
              </button>
            </div>
          </div>
        </aside>
      </div>
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
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
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
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [refreshingModeled, setRefreshingModeled] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);
  const modeledStatus = item.modeledGeneration?.status || null;
  const modeledBusy = modeledStatus === "processing";
  const modeledError = modeledStatus === "failed" ? item.modeledGeneration.error : "";
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
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  const requestBack = useCallback(() => {
    if (!onBackToOutfit) return;
    if (isDirty) nudgeUnsaved();
    else onBackToOutfit();
  }, [isDirty, nudgeUnsaved, onBackToOutfit]);

  const requestNavigate = useCallback((delta) => {
    if (!onNavigate) return;
    if ((delta < 0 && !canPrev) || (delta > 0 && !canNext)) return;
    if (isDirty) nudgeUnsaved();
    else onNavigate(delta);
  }, [canNext, canPrev, isDirty, nudgeUnsaved, onNavigate]);

  useEffect(() => {
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [item.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") {
        if (confirmRegenerate) setConfirmRegenerate(false);
        else if (sampling) setSampling(null);
        else if (onBackToOutfit) requestBack();
        else requestClose();
        return;
      }
      if (confirmRegenerate) return;
      const delta = arrowNavigationDelta(event.key);
      if (!delta) return;
      event.preventDefault();
      requestNavigate(delta);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmRegenerate, onBackToOutfit, requestBack, requestClose, requestNavigate, sampling]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setRefreshingModeled(false);
    setConfirmRegenerate(false);
    setCloseBlocked(false);
    // Intentionally keyed on the item's identity, not the whole object—unrelated
    // patches to the same item (e.g. modeled-photo status updates) shouldn't
    // wipe in-progress edits or the extracted color suggestions.
  }, [item.id]);

  const generateModeledPhoto = async () => {
    setConfirmRegenerate(false);
    try {
      const response = await fetch(`/api/import/wardrobe/${item.id}/modeled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "Could not generate a modeled photo.");
      onGenerateModeled(item.id, { modeledImage: value.modeledImage, modeledGeneration: value.modeledGeneration ?? null });
    } catch (requestError) {
      onGenerateModeled(item.id, { modeledGeneration: { status: "failed", error: requestError.message } });
    }
  };

  const requestModeledPhoto = () => {
    if (hasModeledImage) setConfirmRegenerate(true);
    else generateModeledPhoto();
  };

  const refreshModeledStatus = async () => {
    setRefreshingModeled(true);
    try {
      const response = await fetch(`/api/import/wardrobe/${item.id}`, { cache: "no-store" });
      const value = await response.json().catch(() => ({}));
      if (response.ok) onGenerateModeled(item.id, { modeledImage: value.modeledImage, modeledGeneration: value.modeledGeneration ?? null });
    } catch {
      // Transient network hiccups shouldn't surface as an error—just try again later.
    } finally {
      setRefreshingModeled(false);
    }
  };

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("Changes saved.");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
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
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
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
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
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
          <OptimizedImage
            className="modeled-hero-photo"
            src={item.modeledImage}
            alt={`${draft.name || type} worn by a model`}
            sizes="(max-width: 860px) 100vw, 520px"
            breakpoints={[320, 480, 640, 800, 1040, 1280]}
            quality={82}
            priority
          />
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className={`viewer-heading${onBackToOutfit ? " has-back" : ""}`}>
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="modeled-photo-control">
        <div className="modeled-photo-row">
          {modeledBusy ? (
            <button className="secondary-button modeled-photo-refresh" type="button" onClick={refreshModeledStatus} disabled={refreshingModeled}>
              {refreshingModeled ? <SpinnerGap size={15} weight="bold" className="import-spinner" aria-hidden="true" /> : <ArrowClockwise size={15} weight="regular" aria-hidden="true" />}
              {refreshingModeled ? "Checking…" : "Check status"}
            </button>
          ) : (
            <button className="secondary-button modeled-photo-button" type="button" onClick={requestModeledPhoto}>
              <Sparkle size={15} weight="regular" aria-hidden="true" />
              {hasModeledImage ? "Regenerate modeled photo" : "Generate modeled photo"}
            </button>
          )}
        </div>
        {modeledBusy && <p className="modeled-photo-status" role="status">Generating in the background—this can take up to a minute. Check back whenever you like.</p>}
        {modeledError && <p className="modeled-photo-error" role="alert">{modeledError}</p>}
      </div>

      {confirmRegenerate && (
        <div
          className="confirm-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmRegenerate(false);
          }}
        >
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="regenerate-modeled-title"
            aria-describedby="regenerate-modeled-detail"
          >
            <p className="confirm-modal-eyebrow">Modeled photo</p>
            <h3 className="confirm-modal-title" id="regenerate-modeled-title">Regenerate this look?</h3>
            <p className="confirm-modal-detail" id="regenerate-modeled-detail">
              A new modeled photo will replace the current one. This can take up to a minute.
            </p>
            <div className="confirm-modal-actions">
              <button className="secondary-button" type="button" onClick={() => setConfirmRegenerate(false)}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={generateModeledPhoto}>
                <Sparkle size={15} weight="fill" aria-hidden="true" />
                Regenerate
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="viewer-details editing">
        {hasModeledImage && (
          <div className="viewer-heading modeled-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
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

        {closeBlocked && isDirty && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> Delete
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing}>Cancel</button>
          <button className="primary-button" type="button" onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> Save
          </button>
        </div>
      </div>
    </aside>
    </div>
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
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
  const [outfitGenerating, setOutfitGenerating] = useState(false);
  const [selectedOutfitId, setSelectedOutfitId] = useState(null);
  const [returnOutfitId, setReturnOutfitId] = useState(null);

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
          if (!loadedOutfits.some((outfit) => outfit.status === "processing")) setOutfitGenerating(false);
        })
        .catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [outfits]);

  const selectedItem = items.find((item) => item.id === selectedId) || null;
  const selectedOutfit = outfits.find((outfit) => outfit.id === selectedOutfitId) || null;
  const selectedOutfitGarments = useMemo(() => {
    if (!selectedOutfit) return [];
    return (selectedOutfit.garmentIds || [])
      .map((id) => items.find((item) => item.id === id))
      .filter(Boolean);
  }, [items, selectedOutfit]);

  const openItem = useCallback((id) => {
    setReturnOutfitId(null);
    setSelectedOutfitId(null);
    setSelectedId(id);
  }, []);

  const openOutfit = useCallback((id) => {
    setReturnOutfitId(null);
    setSelectedId(null);
    setSelectedOutfitId(id);
  }, []);

  const openGarmentFromOutfit = useCallback((garmentId) => {
    setReturnOutfitId(selectedOutfitId);
    setSelectedOutfitId(null);
    setSelectedId(garmentId);
  }, [selectedOutfitId]);

  const backToOutfit = useCallback(() => {
    if (!returnOutfitId) return;
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

  const visibleItems = useMemo(() => {
    const matchesType = (item) => activeType === "all" || item.part === activeType;

    if (deferredSearchQuery) {
      return garmentFuse
        .search(deferredSearchQuery)
        .map((result) => itemsById.get(result.item.id))
        .filter((item) => item && matchesType(item));
    }

    const filtered = items.filter(matchesType);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, deferredSearchQuery, garmentFuse, items, itemsById]);

  const visibleOutfits = useMemo(() => {
    const matchesType = (outfit) => {
      if (activeType === "all") return true;
      return (outfit.garmentIds || []).some((id) => itemsById.get(id)?.part === activeType);
    };

    if (deferredSearchQuery) {
      const rankedIds = outfitFuse.search(deferredSearchQuery).map((result) => result.item.id);
      const rank = new Map(rankedIds.map((id, index) => [id, index]));
      return outfits
        .filter((outfit) => rank.has(outfit.id) && matchesType(outfit))
        .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    }

    return outfits.filter(matchesType);
  }, [activeType, deferredSearchQuery, itemsById, outfitFuse, outfits]);

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
      return;
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

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        const response = await fetch(`/api/import/wardrobe/${id}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error("Could not delete the imported item.");
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    setComposerItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
    setReturnOutfitId(null);
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
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
      if (current.some((entry) => entry.part === item.part)) {
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
    if (composerItems.length < 2 || outfitGenerating) return;
    setComposerError("");
    setOutfitGenerating(true);
    try {
      const response = await fetch("/api/import/outfits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          garmentIds: composerItems.map((item) => item.id),
          prompt: composerPrompt.trim(),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not generate the outfit.");
      setOutfits((current) => [result, ...current.filter((outfit) => outfit.id !== result.id)]);
      setComposerItems([]);
      setComposerPrompt("");
    } catch (requestError) {
      setComposerError(requestError.message);
      setOutfitGenerating(false);
    }
  }, [composerItems, composerPrompt, outfitGenerating]);

  return (
    <div className={`app-shell${selectedItem || selectedOutfit ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <div className="gallery-toolbar">
          <OutfitComposer
            items={composerItems}
            prompt={composerPrompt}
            onPromptChange={setComposerPrompt}
            error={composerError}
            generating={outfitGenerating || outfits.some((outfit) => outfit.status === "processing")}
            onAdd={addToComposer}
            onRemove={removeFromComposer}
            onGenerate={generateOutfit}
          />
          <GallerySearch value={searchQuery} onChange={setSearchQuery} />
        </div>

        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count">
              {deferredSearchQuery
                ? `${visibleItems.length} ${visibleItems.length === 1 ? "match" : "matches"}`
                : `${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
            </p>
          </div>
          <nav className="category-nav" aria-label="Filter wardrobe by item type">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={activeType === type.id ? "active" : ""}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}
        {!error && loading && <p className="status">Loading wardrobe</p>}
        {!error && !loading && !items.length && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}
        {!error && !loading && !!items.length && !visibleItems.length && (
          <p className="status empty">No garments match this search.</p>
        )}

        {!!visibleItems.length && (
          <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
            {visibleItems.map((item) => (
              <GalleryItem
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={openItem}
              />
            ))}
          </section>
        )}

        <OutfitsSection outfits={visibleOutfits} selectedId={selectedOutfitId} onOpen={openOutfit} />
      </main>

      {selectedItem && (
        <ItemViewer
          item={selectedItem}
          onClose={closeItemViewer}
          onSave={saveItem}
          onDelete={deleteItem}
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
          onDelete={deleteOutfit}
          onSave={saveOutfitName}
          onOpenGarment={openGarmentFromOutfit}
          onNavigate={navigateOutfit}
          canPrev={outfitNavBounds.canPrev}
          canNext={outfitNavBounds.canNext}
        />
      )}
      <WardrobeImportFlow onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />
    </div>
  );
}
