import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, ShoppingBag, Sparkle, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal.jsx";
import { ImageZoomLightbox } from "./ImageZoomLightbox.jsx";
import "./import-flow.css";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const PARTS = [
  ["upperbody", "Tops"],
  ["lowerbody", "Bottoms"],
  ["wholebody_up", "Jackets"],
  ["accessories_up", "Accessories"],
  ["shoes", "Shoes"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "The import job could not be updated.");
  return value;
}

function costsFromJob(job) {
  const costs = {
    ...(job?.stages?.garment?.cost ? { garment: job.stages.garment.cost } : {}),
    ...(job?.stages?.modeled?.cost ? { modeled: job.stages.modeled.cost } : {}),
  };
  return Object.keys(costs).length ? costs : null;
}

async function wardrobeCostsFor(wardrobeId, job) {
  try {
    const record = await api(`/api/import/wardrobe/${wardrobeId}`);
    if (record?.costs && Object.keys(record.costs).length) return record.costs;
  } catch {
    // Fall back to costs already present on the job stages.
  }
  return costsFromJob(job);
}

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "Import needs attention", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "review") return { tone: "ready", text: "Modeled image ready for review" };
  if (modeled?.status === "processing") return { tone: "processing", text: "Styling modeled image" };
  if (garment?.status === "review") return { tone: "ready", text: "Ready for review" };
  if (garment?.status === "approved") return { tone: "processing", text: "Creating modeled image" };
  if (crop?.status === "review") return { tone: "ready", text: "Crop ready for review" };
  if (crop?.status === "approved") return { tone: "processing", text: "Creating garment image" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "Import declined" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

function reviewStageFor(job) {
  if (job.stages?.modeled?.status === "review") return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function isReviewable(job) {
  return Boolean(reviewStageFor(job) || hasCleanupFailure(job));
}

function isProcessingJob(job) {
  return (
    (job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status))
    || ["processing", "queued"].includes(job.stages?.modeled?.status)
    || (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "pending")
  );
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
    owned: metadata.owned !== false,
  };
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const isModeled = stage === "modeled";
  const previewAlt = isCrop ? "Detected item crop" : isGarment ? "Extracted garment" : "Generated modeled look";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      {(isGarment || isModeled) && asset ? (
        <button
          type="button"
          className="import-editor__preview-button image-zoom-trigger"
          onClick={() => setLightboxOpen(true)}
          aria-label={isGarment ? "View larger garment photo" : "View larger modeled photo"}
        >
          <img className="import-editor__preview" src={asset} alt={previewAlt} />
        </button>
      ) : (
        <img className="import-editor__preview" src={asset} alt={previewAlt} />
      )}
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : isGarment ? "Garment image" : "Modeled image"}</p>
        {isCrop ? <p className="import-card__detail">Check that this crop contains the complete intended item. Approving it starts the clean garment-image generation.</p> : isGarment ? (
          <>
            <label className="import-ownership-toggle">
              <input
                type="checkbox"
                checked={draft.owned === false}
                onChange={(event) => setDraft({ ...draft, owned: !event.target.checked })}
              />
              <span className="import-ownership-toggle__mark" aria-hidden="true">
                <ShoppingBag size={14} weight="regular" />
              </span>
              <span className="import-ownership-toggle__copy">
                <span className="import-ownership-toggle__title">Not owned</span>
                <span className="import-ownership-toggle__hint">Mark pieces you want but don’t have yet</span>
              </span>
            </label>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="navy, casual, polo, collared, relaxed-fit" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">Approve this editorial image to attach it to the new wardrobe piece, or regenerate it with a more specific direction.</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>Regeneration direction <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "Example: preserve the original zipper and remove the retail tag" : "Example: use a quiet evening street and show the full garment"} />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> Reject</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> Regenerate</button>}
          <button className="import-button import-button--primary" disabled={busy || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "Use crop" : "Approve"}</button>
        </div>
      </div>
      {lightboxOpen && asset && (
        <ImageZoomLightbox
          className="import-image-zoom-lightbox"
          src={asset}
          alt={previewAlt}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(previewTimer.current);
    };
  }, []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      if (mountedRef.current) onPreview(next);
    }, 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">Background cleanup</p>
      <p className="import-card__detail">The generated garment is preserved below. Adjust the cleanup locally—this does not call the image model again.</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="Generated garment on its chroma background" /><figcaption>Generated source</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="Transparent garment cleanup preview" /><figcaption>{stage.cleanupPreviewUrl ? "Cleanup preview" : "Preview appears here"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>Cleanup strength <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>Preserve more edge detail</span><span>Remove more background</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">The automated check sees {contaminated.toLocaleString()} tinted edge {contaminated === 1 ? "pixel" : "pixels"}. If the preview looks clean, you can still use it.</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> Preview cleanup</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> Use this cleanup</button>
      </div>
    </div>
  );
}

function processingKeys(outfits, garments) {
  const outfitIds = new Set(outfits.map((outfit) => outfit.id));
  const garmentKeys = new Set();
  for (const item of garments) {
    if (item.garmentGeneration?.status === "processing") garmentKeys.add(`${item.id}:garment`);
    if (item.modeledGeneration?.status === "processing") garmentKeys.add(`${item.id}:modeled`);
  }
  return { outfitIds, garmentKeys };
}

function outfitStatusMap(outfits) {
  return new Map(outfits.map((outfit) => [outfit.id, outfit.status || ""]));
}

export function WardrobeImportFlow({
  onGarmentApproved,
  onModeledApproved,
  processingOutfits = [],
  processingGarments = [],
  outfits = [],
  wardrobeItems = [],
  onDeleteOutfit,
  onOpenCompletion,
}) {
  const inputRef = useRef(null);
  const mountedRef = useRef(true);
  const pendingUploadsRef = useRef([]);
  const previousProcessingRef = useRef(processingKeys(processingOutfits, processingGarments));
  const previousOutfitStatusRef = useRef(outfitStatusMap(outfits));
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const [completionItems, setCompletionItems] = useState([]);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [pendingUploads, setPendingUploads] = useState([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const entry of pendingUploadsRef.current) {
        URL.revokeObjectURL(entry.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    pendingUploadsRef.current = pendingUploads;
  }, [pendingUploads]);

  useEffect(() => {
    const controller = new AbortController();
    api(CONFIG_API, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSetup(value);
      })
      .catch((requestError) => {
        if (controller.signal.aborted || requestError.name === "AbortError") return;
        setSetup({ ready: false, error: requestError.message });
      });
    api(API, { signal: controller.signal })
      .then((storedJobs) => {
        if (controller.signal.aborted) return;
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch((requestError) => {
        if (controller.signal.aborted || requestError.name === "AbortError") return;
      });
    return () => controller.abort();
  }, []);

  const refresh = useCallback(async (id, signal) => {
    try {
      const next = await api(`${API}/${id}`, signal ? { signal } : undefined);
      if (signal?.aborted || !mountedRef.current) return;
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) {
      if (signal?.aborted || requestError.name === "AbortError" || !mountedRef.current) return;
      setError(requestError.message);
    }
  }, []);

  const processingJobIds = jobs
    .filter(isProcessingJob)
    .map((job) => job.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!processingJobIds) return undefined;
    const ids = processingJobIds.split(",");
    let activeController = null;
    const timer = setInterval(() => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      ids.forEach((id) => {
        void refresh(id, controller.signal);
      });
    }, 900);
    return () => {
      activeController?.abort();
      clearInterval(timer);
    };
  }, [processingJobIds, refresh]);

  const selectReviewJob = useCallback((jobId) => {
    setSelectedReviewId(jobId);
  }, []);

  useEffect(() => {
    const currentStatuses = outfitStatusMap(outfits);
    const previousStatuses = previousOutfitStatusRef.current;
    const current = processingKeys(processingOutfits, processingGarments);
    const previous = previousProcessingRef.current;
    const finished = [];

    for (const [id, status] of currentStatuses) {
      if (status !== "ready") continue;
      const was = previousStatuses.get(id);
      if (was === "ready" || (was !== "processing" && !previous.outfitIds.has(id))) continue;
      const outfit = outfits.find((entry) => entry.id === id);
      if (!outfit?.image) continue;
      finished.push({
        kind: "outfit",
        id: outfit.id,
        name: outfit.name || "Outfit",
        image: outfit.image,
      });
    }

    for (const key of previous.garmentKeys) {
      if (current.garmentKeys.has(key)) continue;
      const [id, kind] = key.split(":");
      const item = wardrobeItems.find((entry) => entry.id === id);
      if (!item) continue;
      if (kind === "modeled" && item.modeledImage && item.modeledGeneration?.status !== "failed") {
        finished.push({
          kind: "modeled",
          id: item.id,
          name: item.name || "Modeled photo",
          image: item.modeledImage,
        });
      }
      if (kind === "garment" && item.garmentGeneration?.status !== "failed") {
        finished.push({
          kind: "garment",
          id: item.id,
          name: item.name || "Garment",
          image: item.image || item.thumbnail || null,
        });
      }
    }

    previousOutfitStatusRef.current = currentStatuses;
    previousProcessingRef.current = current;
    if (!finished.length) return;

    setCompletionItems((current) => {
      const next = [...current];
      for (const entry of finished) {
        const key = `${entry.kind}:${entry.id}`;
        const index = next.findIndex((item) => `${item.kind}:${item.id}` === key);
        if (index === -1) next.push(entry);
        else next[index] = entry;
      }
      return next;
    });
  }, [outfits, processingGarments, processingOutfits, wardrobeItems]);

  const clearCompletionBadge = useCallback(() => {
    setCompletionItems([]);
  }, []);

  const openActivity = useCallback(() => {
    setOpen(true);
  }, []);

  const closeActivity = useCallback(() => {
    setOpen(false);
    clearCompletionBadge();
  }, [clearCompletionBadge]);

  const dismissCompletionItem = useCallback((entry) => {
    setCompletionItems((current) => current.filter((item) => !(item.kind === entry.kind && item.id === entry.id)));
  }, []);

  const openCompletionItem = useCallback((entry) => {
    setOpen(false);
    setCompletionItems((current) => current.filter((item) => !(item.kind === entry.kind && item.id === entry.id)));
    onOpenCompletion?.(entry);
  }, [onOpenCompletion]);

  const completionCount = completionItems.length;
  const completionPreview = completionItems[completionItems.length - 1] || null;
  const completionMessage = (() => {
    if (!completionCount) return "";
    if (completionCount === 1) {
      if (completionPreview.kind === "outfit") return "Outfit ready";
      if (completionPreview.kind === "modeled") return "Modeled photo ready";
      return "Garment ready";
    }
    const kinds = new Set(completionItems.map((entry) => entry.kind));
    if (kinds.size === 1) {
      const kind = [...kinds][0];
      if (kind === "outfit") return `${completionCount} outfits ready`;
      if (kind === "modeled") return `${completionCount} modeled photos ready`;
      return `${completionCount} garments ready`;
    }
    return `${completionCount} generations ready`;
  })();

  const completionLabel = (entry) => {
    if (entry.kind === "outfit") return "Outfit";
    if (entry.kind === "modeled") return "Modeled photo";
    return "Garment";
  };

  const submitFiles = useCallback(async (files) => {
    if (!setup?.ready) { setOpen(true); return; }
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setDragging(false); setError(""); setNotice(null);
    for (const file of images) {
      const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = URL.createObjectURL(file);
      const pendingName = file.name.replace(/\.[^.]+$/, "") || "New piece";
      if (!mountedRef.current) {
        URL.revokeObjectURL(previewUrl);
        return;
      }
      setPendingUploads((current) => [...current, { id: pendingId, name: pendingName, previewUrl }]);
      try {
        const imageDataUrl = await fileToDataUrl(file);
        if (!mountedRef.current) return;
        const result = await api(API, { method: "POST", body: JSON.stringify({ imageDataUrl, metadata: { name: pendingName } }) });
        if (!mountedRef.current) return;
        const createdJobs = result.jobs || [result];
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "No clothing detected", detail: `We couldn’t find a distinct wearable item in ${file.name}. Try a clearer or more tightly framed image.` });
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
      } catch (requestError) {
        if (mountedRef.current) setError(requestError.message);
      } finally {
        if (mountedRef.current) {
          setPendingUploads((current) => current.filter((entry) => entry.id !== pendingId));
        }
        URL.revokeObjectURL(previewUrl);
      }
    }
  }, [setup]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = {
          name: draft.name,
          part: draft.part,
          color: draft.color,
          secondaryColor: draft.secondaryColor || null,
          tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          owned: draft.owned !== false,
        };
        await api(`${API}/${job.id}/metadata`, { method: "PATCH", body: JSON.stringify({ metadata }) });
        const updated = await api(`${API}/${job.id}/stages/garment/approve`, { method: "POST" });
        const wardrobeId = `import-${job.id}`;
        const garmentPath = `/api/import/library/${wardrobeId}-garment.png`;
        const costs = await wardrobeCostsFor(wardrobeId, updated);
        onGarmentApproved?.({
          id: wardrobeId,
          ...metadata,
          image: garmentPath,
          thumbnail: garmentPath,
          modeledImage: null,
          palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
          importJobId: job.id,
          ...(costs ? { costs } : {}),
        });
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else {
        const updated = await api(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: action === "regenerate" ? JSON.stringify({ prompt }) : undefined });
        const removeFromQueue = action === "reject" || (stage === "modeled" && action === "approve");
        setJobs((current) => removeFromQueue ? current.filter((item) => item.id !== job.id) : current.map((item) => item.id === job.id ? updated : item));
        if (removeFromQueue) {
          setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
          setSelectedReviewId((current) => (current === job.id ? null : current));
        }
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
        if (stage === "modeled" && action === "approve") {
          const wardrobeId = `import-${job.id}`;
          const costs = await wardrobeCostsFor(wardrobeId, updated);
          onModeledApproved?.(job.id, `/api/import/library/${wardrobeId}-modeled.png`, costs);
        }
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await api(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await api(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      setDeleteConfirm(null);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const requestDeleteJob = (job) => {
    const itemName = drafts[job.id]?.name || job.metadata?.name || "this import";
    setDeleteConfirm({
      kind: "job",
      job,
      eyebrow: "Import",
      title: `Remove ${itemName}?`,
      detail: "This import will be discarded from the queue.",
      confirmLabel: "Remove",
    });
  };

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const pendingCount = pendingUploads.length;
  const croppingStatus = pendingCount
    ? { tone: "processing", text: pendingCount === 1 ? "Cropping image" : `Cropping ${pendingCount} images` }
    : null;
  const importStatus = setupRequired
    ? { tone: "error", text: "Setup required" }
    : croppingStatus || (active ? deriveStatus(active) : notice);
  const outfitCount = processingOutfits.length;
  const regeneratingGarmentItems = processingGarments.filter((item) => item.garmentGeneration?.status === "processing");
  const regeneratingModeledItems = processingGarments.filter((item) => item.modeledGeneration?.status === "processing");
  const regeneratingGarmentCount = regeneratingGarmentItems.length;
  const regeneratingModeledCount = regeneratingModeledItems.length;
  const wardrobeRegenCount = processingGarments.length;
  const backgroundCount = outfitCount + wardrobeRegenCount;
  const outfitStatus = outfitCount
    ? { tone: "processing", text: outfitCount === 1 ? "Generating outfit" : `Generating ${outfitCount} outfits` }
    : null;
  const wardrobeRegenStatus = (() => {
    if (!wardrobeRegenCount) return null;
    if (regeneratingGarmentCount && regeneratingModeledCount) {
      return { tone: "processing", text: "Updating wardrobe pieces" };
    }
    if (regeneratingGarmentCount) {
      return {
        tone: "processing",
        text: regeneratingGarmentCount === 1 ? "Regenerating garment" : `Regenerating ${regeneratingGarmentCount} garments`,
      };
    }
    return {
      tone: "processing",
      text: regeneratingModeledCount === 1 ? "Generating modeled photo" : `Generating ${regeneratingModeledCount} modeled photos`,
    };
  })();
  const backgroundStatus = outfitCount && wardrobeRegenCount
    ? { tone: "processing", text: "Generating looks" }
    : (outfitStatus || wardrobeRegenStatus);
  const importBusyWithOutfits = Boolean(outfitCount && importStatus?.tone === "processing");
  const mixedBusyStatus = importBusyWithOutfits || (outfitCount && wardrobeRegenCount)
    ? { tone: "processing", text: "Generating looks" }
    : null;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const importProcessingCount = jobs.filter((job) => deriveStatus(job).tone === "processing").length + pendingCount;
  const firstReviewable = jobs.find((job) => isReviewable(job));
  const effectiveSelectedId = selectedReviewId && jobs.some((job) => job.id === selectedReviewId)
    ? selectedReviewId
    : (firstReviewable?.id ?? null);
  const selectedJob = effectiveSelectedId ? jobs.find((job) => job.id === effectiveSelectedId) || null : null;
  const reviewJob = selectedJob && isReviewable(selectedJob) ? selectedJob : null;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const hasImportActivity = Boolean(jobs.length || pendingCount || notice || setupRequired);
  const hasCompletionBadge = completionCount > 0;
  const hasActivity = hasImportActivity || backgroundCount > 0 || hasCompletionBadge;
  const completionStatus = hasCompletionBadge
    ? { tone: "complete", text: completionMessage || "Generation ready" }
    : null;
  const activeStatus = importStatus?.tone === "ready" || importStatus?.tone === "error"
    ? importStatus
    : mixedBusyStatus
      || croppingStatus
      || (importStatus?.tone === "processing" ? importStatus : null)
      || backgroundStatus
      || completionStatus
      || importStatus;
  const trayLoadingText = (() => {
    if (activeStatus?.tone !== "processing") return null;
    if (pendingCount && !jobs.length && !backgroundCount) {
      return pendingCount === 1 ? "Cropping image" : `Cropping ${pendingCount} images`;
    }
    const parts = [];
    if (outfitCount) parts.push(outfitCount === 1 ? "1 outfit" : `${outfitCount} outfits`);
    if (regeneratingGarmentCount) parts.push(regeneratingGarmentCount === 1 ? "1 garment" : `${regeneratingGarmentCount} garments`);
    if (regeneratingModeledCount) parts.push(regeneratingModeledCount === 1 ? "1 modeled photo" : `${regeneratingModeledCount} modeled photos`);
    if (pendingCount) parts.push(pendingCount === 1 ? "1 crop" : `${pendingCount} crops`);
    if (importProcessingCount - pendingCount) {
      const count = importProcessingCount - pendingCount;
      parts.push(count === 1 ? "1 piece" : `${count} pieces`);
    }
    if (!parts.length) return activeStatus.text || "Generating";
    if (!backgroundCount && pendingCount && !(importProcessingCount - pendingCount)) {
      return pendingCount === 1 ? "Cropping image" : `Cropping ${pendingCount} images`;
    }
    if (!backgroundCount && importProcessingCount) {
      return importProcessingCount === 1 ? "Preparing 1 piece" : `Preparing ${importProcessingCount} pieces`;
    }
    if (parts.length === 1 && !importProcessingCount) {
      if (outfitCount) return outfitCount === 1 ? "Generating outfit" : `Generating ${outfitCount} outfits`;
      if (regeneratingGarmentCount) return regeneratingGarmentCount === 1 ? "Regenerating garment" : `Regenerating ${regeneratingGarmentCount} garments`;
      if (regeneratingModeledCount) return regeneratingModeledCount === 1 ? "Generating modeled photo" : `Generating ${regeneratingModeledCount} modeled photos`;
    }
    return `Generating ${parts.join(" · ")}`;
  })();
  const showProcessingBar = activeStatus?.tone === "processing";
  const mixedBackground = Boolean((jobs.length && backgroundCount) || (outfitCount && wardrobeRegenCount));
  const popoverTitle = readyCount
    ? `${readyCount} ready for review`
    : importStatus?.tone === "error"
      ? "Import needs attention"
      : mixedBusyStatus
        ? mixedBusyStatus.text
        : pendingCount && !jobs.length
          ? croppingStatus.text
          : jobs.length || pendingCount
            ? "Preparing new pieces"
            : backgroundStatus?.text || completionMessage || notice?.text || "Add to your wardrobe";
  const popoverEyebrow = mixedBackground || (jobs.length && backgroundCount) || importBusyWithOutfits
    ? "Wardrobe activity"
    : pendingCount && !jobs.length && !backgroundCount
      ? "Wardrobe import"
      : outfitCount && !jobs.length && !wardrobeRegenCount
        ? "Outfit generation"
        : regeneratingGarmentCount && !regeneratingModeledCount && !jobs.length && !outfitCount
          ? "Garment image"
          : regeneratingModeledCount && !regeneratingGarmentCount && !jobs.length && !outfitCount
            ? "Modeled photo"
            : wardrobeRegenCount && !jobs.length && !outfitCount
              ? "Wardrobe updates"
              : "Wardrobe import";

  const pendingUploadCards = pendingCount > 0 && pendingUploads.map((entry) => (
    <article className="import-card is-processing" key={entry.id}>
      <div className="import-card__image import-card__image--loading" aria-hidden="true">
        <img src={entry.previewUrl} alt="" />
        <span className="import-card__spinner"><SpinnerGap size={18} className="import-spinner" /></span>
      </div>
      <div className="import-card__body">
        <h3 className="import-card__title">{entry.name}</h3>
        <p className="import-card__detail import-card__detail--status" data-tone="processing">Cropping image</p>
      </div>
    </article>
  ));

  const backgroundCards = backgroundCount > 0 && (
    <div className={`import-card-list${jobs.length || pendingCount ? " import-card-list--follow" : ""}`}>
      {!jobs.length && !pendingCount && (
        <div className="import-progress is-indeterminate">
          <div className="import-progress__meta">
            <span>{backgroundStatus.text}</span>
            <span>
              {[
                outfitCount ? `${outfitCount} ${outfitCount === 1 ? "outfit" : "outfits"}` : null,
                regeneratingGarmentCount ? `${regeneratingGarmentCount} ${regeneratingGarmentCount === 1 ? "garment" : "garments"}` : null,
                regeneratingModeledCount ? `${regeneratingModeledCount} modeled` : null,
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="import-progress__track"><div className="import-progress__bar" /></div>
        </div>
      )}
      {wardrobeRegenCount > 0 && (
        <>
          {(jobs.length > 0 || outfitCount > 0) && (
            <p className="import-editor__stage">
              {regeneratingGarmentCount && regeneratingModeledCount
                ? "Wardrobe updates"
                : regeneratingGarmentCount
                  ? "Garment images"
                  : "Modeled photos"}
            </p>
          )}
          {processingGarments.map((item) => {
            const regeneratingGarment = item.garmentGeneration?.status === "processing";
            const regeneratingModeled = item.modeledGeneration?.status === "processing";
            const statusText = regeneratingGarment && regeneratingModeled
              ? "Regenerating garment and modeled photo"
              : regeneratingGarment
                ? "Regenerating garment"
                : "Generating modeled photo";
            return (
              <article className="import-card is-processing" key={item.id}>
                <div className="import-card__image import-card__image--outfit" aria-hidden="true">
                  <span className="import-card__rainbow" />
                </div>
                <div className="import-card__body">
                  <h3 className="import-card__title">{item.name || "Garment"}</h3>
                  <p className="import-card__detail import-card__detail--status" data-tone="processing">{statusText}</p>
                </div>
              </article>
            );
          })}
        </>
      )}
      {outfitCount > 0 && (
        <>
          {(jobs.length > 0 || wardrobeRegenCount > 0) && <p className="import-editor__stage">Outfit generation</p>}
          {processingOutfits.map((outfit) => (
            <article className="import-card is-processing" key={outfit.id}>
              <div className="import-card__image import-card__image--outfit" aria-hidden="true">
                <span className="import-card__rainbow" />
              </div>
              <div className="import-card__body">
                <h3 className="import-card__title">{outfit.name || "Outfit"}</h3>
                <p className="import-card__detail import-card__detail--status" data-tone="processing">Generating look</p>
              </div>
              <div className="import-card__actions">
                {onDeleteOutfit && (
                  <button
                    className="import-icon-button import-card__delete"
                    type="button"
                    disabled={busyId === outfit.id}
                    onClick={() => onDeleteOutfit(outfit.id)}
                    aria-label={`Cancel ${outfit.name || "outfit"}`}
                  >
                    <Trash size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </>
      )}
    </div>
  );

  const completionPanel = hasCompletionBadge && (
    <div className="import-completion-panel">
      <div className="import-completion-panel__header">
        <p className="import-editor__stage">Ready</p>
        <p className="import-completion-panel__lead">
          {completionCount === 1
            ? "Open it in the drawer, or dismiss."
            : "Open any look in the drawer, or dismiss each."}
        </p>
      </div>
      <div className="import-completion-list" role="list">
        {completionItems.map((entry) => (
          <div key={`${entry.kind}:${entry.id}`} className="import-completion-item" role="listitem">
            <button
              type="button"
              className="import-completion-item__open"
              onClick={() => openCompletionItem(entry)}
              aria-label={`Open ${entry.name || completionLabel(entry)}`}
            >
              <span className="import-completion-item__media" aria-hidden="true">
                {entry.image ? <img src={entry.image} alt="" /> : <Check size={18} weight="bold" />}
              </span>
              <span className="import-completion-item__meta">
                <span className="import-completion-item__kind">{completionLabel(entry)}</span>
                <span className="import-completion-item__name">{entry.name || completionLabel(entry)}</span>
              </span>
            </button>
            <button
              className="import-icon-button import-completion-item__dismiss"
              type="button"
              onClick={() => {
                const remaining = completionItems.filter((item) => !(item.kind === entry.kind && item.id === entry.id));
                dismissCompletionItem(entry);
                if (!remaining.length && !(jobs.length || backgroundCount)) setOpen(false);
              }}
              aria-label={`Dismiss ${entry.name || completionLabel(entry)}`}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="import-button"
        type="button"
        onClick={() => {
          clearCompletionBadge();
          if (!(jobs.length || backgroundCount)) setOpen(false);
        }}
      >
        Dismiss all
      </button>
    </div>
  );

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden disabled={!setup?.ready} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>Drop clothing images</h2><p>A single garment or a photo of a full outfit works. Your wardrobe stays exactly where you left it.</p></div></div>
      <aside className={`import-tray${hasActivity ? " is-expanded" : ""}${hasCompletionBadge ? " has-completion" : ""}`} aria-label="Wardrobe activity">
        {hasActivity ? (
          <button
            className="import-tray__status"
            type="button"
            onClick={openActivity}
            aria-label={
              setupRequired
                ? "Open setup instructions"
                : hasCompletionBadge
                  ? `${completionMessage || "Generation ready"}. Open results`
                  : trayLoadingText
                    ? `${trayLoadingText}. Open activity`
                    : "Open wardrobe activity"
            }
          >
            <span className={`import-tray__button${hasCompletionBadge && completionPreview?.image ? " import-tray__button--preview" : ""}`}>
              {activeStatus?.tone === "processing" ? (
                <SpinnerGap size={19} className="import-spinner" />
              ) : activeStatus?.tone === "error" ? (
                <WarningCircle size={19} />
              ) : readyCount ? (
                <span>{readyCount}</span>
              ) : hasCompletionBadge && completionPreview?.image ? (
                <img className="import-tray__result" src={completionPreview.image} alt="" />
              ) : hasCompletionBadge ? (
                <Check size={18} weight="bold" />
              ) : outfitCount ? (
                <Sparkle size={18} weight="fill" />
              ) : notice ? (
                <X size={18} />
              ) : (
                <WarningCircle size={19} />
              )}
            </span>
            <span className="import-tray__actions">
              {active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.garment?.failedAssetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}
              <span className="import-tray__label">{trayLoadingText || activeStatus?.text || "Activity"}</span>
            </span>
          </button>
        ) : null}
        {!setupRequired && (
          <button
            className="import-tray__add"
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-label="Add clothes"
            disabled={!setup?.ready}
          >
            <span className="import-tray__button">
              <Plus size={19} />
            </span>
            {!hasActivity && (
              <span className="import-tray__actions">
                <span className="import-tray__label">Add clothes</span>
              </span>
            )}
          </button>
        )}
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && closeActivity()}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header">
            <div>
              <p className="import-popover__eyebrow">{hasCompletionBadge && !jobs.length && !pendingCount && !backgroundCount ? "Complete" : popoverEyebrow}</p>
              <h2 className="import-popover__title" id="import-title">{popoverTitle}</h2>
            </div>
            <button className="import-icon-button" type="button" onClick={closeActivity} aria-label="Close wardrobe activity"><X size={20} /></button>
          </header>

          {!jobs.length && !pendingCount && !backgroundCount ? (
            setupRequired ? (
              <div className="import-drop-target import-setup-warning">
                <WarningCircle size={30} />
                <h2>Setup required</h2>
                <p>Add your OpenAI API key to <code>.env</code> and a PNG reference photo of yourself at <code>{setup.modelReference || "data/model-reference.png"}</code>, then restart the app.</p>
              </div>
            ) : hasCompletionBadge ? (
              completionPanel
            ) : (
              <div className="import-drop-target">
                <UploadSimple size={28} />
                <h2>{notice ? "Try another image" : "Choose or paste an image"}</h2>
                <p>{notice?.detail || "We’ll isolate each clothing item, suggest its details, and hold everything for your approval."}</p>
                <button className="import-button import-button--primary" disabled={!setup?.ready} onClick={() => { setNotice(null); inputRef.current?.click(); }}>Choose images</button>
              </div>
            )
          ) : (
            <>
              {completionPanel}
              {(jobs.length > 0 || pendingCount > 0) && (
                <>
                  <div className={`import-progress${showProcessingBar && importStatus?.tone === "processing" ? " is-indeterminate" : " is-reviewing"}`}>
                    <div className="import-progress__meta">
                      <span>{mixedBusyStatus?.text || importStatus?.text || backgroundStatus?.text}</span>
                      <span>
                        {[
                          jobs.length || pendingCount
                            ? `${jobs.length + pendingCount} ${(jobs.length + pendingCount) === 1 ? "item" : "items"}`
                            : null,
                          pendingCount ? `${pendingCount} cropping` : null,
                          outfitCount ? `${outfitCount} ${outfitCount === 1 ? "outfit" : "outfits"}` : null,
                          regeneratingGarmentCount ? `${regeneratingGarmentCount} ${regeneratingGarmentCount === 1 ? "garment" : "garments"}` : null,
                          regeneratingModeledCount ? `${regeneratingModeledCount} modeled` : null,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {showProcessingBar && <div className="import-progress__track"><div className="import-progress__bar" /></div>}
                  </div>
                  {reviewJob && reviewStage ? (
                    <ReviewEditor
                      key={`${reviewJob.id}:${reviewStage}`}
                      job={reviewJob}
                      stage={reviewStage}
                      draft={drafts[reviewJob.id] || defaultDraft(reviewJob)}
                      setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))}
                      regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""}
                      setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))}
                      busy={busyId === reviewJob.id}
                      onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)}
                    />
                  ) : reviewJob && hasCleanupFailure(reviewJob) ? (
                    <CleanupEditor
                      key={`${reviewJob.id}:cleanup`}
                      job={reviewJob}
                      tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46}
                      setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))}
                      busy={busyId === reviewJob.id}
                      onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)}
                      onAccept={() => performCleanup(reviewJob, "accept")}
                    />
                  ) : null}
                  <div className="import-card-list">
                    {pendingUploadCards}
                    {jobs.map((job) => {
                      const status = deriveStatus(job);
                      const itemName = drafts[job.id]?.name || job.metadata?.name || "New piece";
                      const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null;
                      const previewSrc = job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl;
                      const isProcessing = status.tone === "processing";
                      const selected = effectiveSelectedId === job.id;
                      const canSelect = isReviewable(job) || isProcessing || status.tone === "error";
                      const generatingAsset = isProcessing && (
                        job.stages?.crop?.status === "approved"
                        || job.stages?.garment?.status === "processing"
                        || job.stages?.garment?.status === "approved"
                        || job.stages?.modeled?.status === "processing"
                      );
                      return (
                        <article
                          className={`import-card is-${status.tone}${selected ? " is-selected" : ""}${canSelect ? " is-selectable" : ""}`}
                          key={job.id}
                          onClick={() => {
                            if (canSelect) selectReviewJob(job.id);
                          }}
                        >
                          {generatingAsset ? (
                            <div className="import-card__image import-card__image--outfit" aria-hidden="true">
                              <span className="import-card__rainbow" />
                            </div>
                          ) : isProcessing ? (
                            <div className="import-card__image import-card__image--loading" aria-hidden="true">
                              {previewSrc ? <img src={previewSrc} alt="" /> : <SpinnerGap size={22} className="import-spinner" />}
                              <span className="import-card__spinner"><SpinnerGap size={18} className="import-spinner" /></span>
                            </div>
                          ) : (
                            <img className="import-card__image" src={previewSrc} alt="" />
                          )}
                          <div className="import-card__body">
                            <h3 className="import-card__title">{itemName}</h3>
                            <p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p>
                          </div>
                          <div className="import-card__actions" onClick={(event) => event.stopPropagation()}>
                            {status.tone === "ready" && (
                              <button
                                className="import-icon-button"
                                type="button"
                                onClick={() => selectReviewJob(job.id)}
                                aria-label={`Review ${itemName}`}
                              >
                                <Check size={17} />
                              </button>
                            )}
                            {failedStage && <button className="import-button import-card__retry" type="button" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> Retry</button>}
                            <button className="import-icon-button import-card__delete" type="button" disabled={busyId === job.id} onClick={() => requestDeleteJob(job)} aria-label={`Delete ${itemName} from import queue`}><Trash size={16} /></button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
              {backgroundCards}
              <div className="import-actions">
                <button className="import-button" type="button" onClick={() => inputRef.current?.click()}><Plus size={14} /> {jobs.length || pendingCount ? "Add another" : "Add clothes"}</button>
              </div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
      {deleteConfirm?.kind === "job" && (
        <ConfirmDeleteModal
          elevated
          eyebrow={deleteConfirm.eyebrow}
          title={deleteConfirm.title}
          detail={deleteConfirm.detail}
          confirmLabel={deleteConfirm.confirmLabel}
          busy={busyId === deleteConfirm.job.id}
          onCancel={() => {
            if (busyId !== deleteConfirm.job.id) setDeleteConfirm(null);
          }}
          onConfirm={() => deleteJob(deleteConfirm.job)}
        />
      )}
    </>
  );
}
