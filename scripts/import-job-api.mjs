import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  DEFAULT_OUTFIT_SETTING,
  PART_LABEL,
  buildDuoOutfitPrompt,
  buildGarmentPrompt,
  buildModeledPrompt,
  buildOutfitPrompt,
  buildOutfitSuggestPrompt,
  ensureRequiredParts,
  improveOutfitColorPairing,
  outfitNameFromGarments,
  sortGarmentsByPart,
} from "./prompts.mjs";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const OUTFIT_ASSET_ROOT = "/api/import/outfit-images";
const MODEL_ASSET_ROOT = "/api/import/model-images";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function decodeImage(input) {
  const raw = input.imageDataUrl || input.imageBase64;
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl or imageBase64 is required"), { status: 400 });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || input.mimeType || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set();
  const tags = [];
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().replace(/^#/, "").toLowerCase().slice(0, 40);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

function resolveOutfitTags(outfit = {}) {
  return Array.isArray(outfit.tags) ? normalizeTags(outfit.tags) : [];
}

function outfitGenerationDirection(outfit = {}) {
  return typeof outfit.prompt === "string" ? outfit.prompt.trim() : "";
}

function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: normalizeTags(metadata.tags),
    owned: metadata.owned !== false,
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

/** Merge a partial user edit onto an existing wardrobe record; unset fields keep their current value. */
function normalizeWardrobePatch(existing, input = {}) {
  const patch = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const next = { ...existing };
  if (typeof patch.name === "string") {
    const name = patch.name.trim().slice(0, 120);
    if (name) next.name = name;
  }
  if (PARTS.has(patch.part)) next.part = patch.part;
  if (typeof patch.color === "string" && HEX_COLOR.test(patch.color)) next.color = patch.color.toLowerCase();
  if (patch.secondaryColor === null) next.secondaryColor = null;
  else if (typeof patch.secondaryColor === "string" && HEX_COLOR.test(patch.secondaryColor)) next.secondaryColor = patch.secondaryColor.toLowerCase();
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
  if (patch.owned !== undefined) next.owned = patch.owned !== false;
  return next;
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

async function openAIDetectFaceBox({ key, baseUrl, model, image }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Locate the primary person's face in this photo for an avatar crop.",
              "Return one tight bounding box around the face including a little hair and chin, using integer coordinates normalized to a 1000 by 1000 image.",
              "x and y are the top-left corner, followed by width and height.",
              "If multiple people are present, choose the most prominent / front-facing face.",
              "If no face is clearly visible, return a centered upper-body head box as a best-effort fallback.",
            ].join(" "),
          },
          { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` },
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "face_box",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              boundingBox: {
                type: "object",
                additionalProperties: false,
                properties: {
                  x: { type: "integer", minimum: 0, maximum: 999 },
                  y: { type: "integer", minimum: 0, maximum: 999 },
                  width: { type: "integer", minimum: 1, maximum: 1000 },
                  height: { type: "integer", minimum: 1, maximum: 1000 },
                },
                required: ["x", "y", "width", "height"],
              },
            },
            required: ["boundingBox"],
          },
        },
      },
    }),
  });
  const bodyText = await response.text();
  let result = {};
  try { result = bodyText ? JSON.parse(bodyText) : {}; }
  catch { result = {}; }
  if (!response.ok) throw openaiFailureError("analysis", response.status, bodyText, result);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw Object.assign(new Error("OpenAI face detection returned no structured result"), { detail: bodyText.slice(0, 2000) || null });
  const parsed = JSON.parse(outputText);
  return normalizeBoundingBox(parsed.boundingBox);
}

async function applyCircularMask(squareBytes, size = 512) {
  const resized = await sharp(squareBytes)
    .resize(size, size, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .png()
    .toBuffer();
  const circleSvg = Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(resized)
    .composite([{ input: circleSvg, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function createCircularFacePreview(bytes, { key = "", baseUrl = "", visionModel = "gpt-5.4-mini" } = {}) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  let box = null;
  if (key) {
    try {
      box = await openAIDetectFaceBox({ key, baseUrl, model: visionModel, image: normalized });
    } catch {
      box = null;
    }
  }
  let extract;
  if (box) {
    const rawLeft = (box.x / 1000) * width;
    const rawTop = (box.y / 1000) * height;
    const rawWidth = (box.width / 1000) * width;
    const rawHeight = (box.height / 1000) * height;
    const side = Math.max(rawWidth, rawHeight) * 1.35;
    const centerX = rawLeft + rawWidth / 2;
    const centerY = rawTop + rawHeight / 2;
    const left = Math.max(0, Math.floor(centerX - side / 2));
    const top = Math.max(0, Math.floor(centerY - side / 2));
    const widthPx = Math.min(width - left, Math.ceil(side));
    const heightPx = Math.min(height - top, Math.ceil(side));
    const squareSide = Math.min(widthPx, heightPx);
    extract = { left, top, width: squareSide, height: squareSide };
  } else {
    const side = Math.min(width, height);
    extract = {
      left: Math.max(0, Math.floor((width - side) / 2)),
      top: Math.max(0, Math.floor(height * 0.08)),
      width: side,
      height: Math.min(side, height),
    };
    if (extract.top + extract.height > height) extract.top = Math.max(0, height - extract.height);
  }
  const square = await sharp(normalized).extract(extract).png().toBuffer();
  return applyCircularMask(square, 512);
}

function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

function openaiFailureError(kind, status, bodyText, parsed) {
  const message = parsed?.error?.message || `OpenAI ${kind} request failed (${status})`;
  const detail = typeof parsed?.error === "object"
    ? JSON.stringify(parsed.error)
    : (bodyText || "").slice(0, 2000) || null;
  return Object.assign(new Error(message), {
    status,
    detail,
    responseBody: (bodyText || "").slice(0, 4000) || null,
  });
}

/** Per-1M-token rates used to estimate USD from Images API usage. */
const IMAGE_MODEL_RATES = {
  "gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "gpt-image-1": { textInput: 5, imageInput: 10, imageOutput: 40 },
  "gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
};

/** Per-1M-token rates for Responses / chat text models used by outfit suggest. */
const TEXT_MODEL_RATES = {
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
};

function ratesForImageModel(model) {
  if (IMAGE_MODEL_RATES[model]) return IMAGE_MODEL_RATES[model];
  if (typeof model === "string" && model.startsWith("gpt-image-1-mini")) return IMAGE_MODEL_RATES["gpt-image-1-mini"];
  if (typeof model === "string" && model.startsWith("gpt-image-1.5")) return IMAGE_MODEL_RATES["gpt-image-1.5"];
  if (typeof model === "string" && model.startsWith("gpt-image-1")) return IMAGE_MODEL_RATES["gpt-image-1"];
  return IMAGE_MODEL_RATES["gpt-image-2"];
}

function ratesForTextModel(model) {
  if (TEXT_MODEL_RATES[model]) return TEXT_MODEL_RATES[model];
  if (typeof model === "string") {
    if (model.includes("5.4-nano")) return TEXT_MODEL_RATES["gpt-5.4-nano"];
    if (model.includes("5.4-mini")) return TEXT_MODEL_RATES["gpt-5.4-mini"];
    if (model.includes("5.4")) return TEXT_MODEL_RATES["gpt-5.4"];
    if (model.includes("4.1-nano")) return TEXT_MODEL_RATES["gpt-4.1-nano"];
    if (model.includes("4.1-mini")) return TEXT_MODEL_RATES["gpt-4.1-mini"];
    if (model.includes("4o-mini")) return TEXT_MODEL_RATES["gpt-4o-mini"];
  }
  return TEXT_MODEL_RATES["gpt-5.4-mini"];
}

function buildGenerationCost(model, usage) {
  if (!usage || typeof usage !== "object") return null;
  const textTokens = Number(usage.input_tokens_details?.text_tokens) || 0;
  const imageTokens = Number(usage.input_tokens_details?.image_tokens) || 0;
  const inputTokens = Number(usage.input_tokens) || (textTokens + imageTokens);
  const outputTokens = Number(usage.output_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || (inputTokens + outputTokens);
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  const rates = ratesForImageModel(model);
  const billedText = textTokens || Math.max(0, inputTokens - imageTokens);
  const billedImageIn = imageTokens;
  const estimatedUsd = (billedText * rates.textInput + billedImageIn * rates.imageInput + outputTokens * rates.imageOutput) / 1_000_000;
  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    textTokens: textTokens || null,
    imageTokens: imageTokens || null,
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    at: new Date().toISOString(),
  };
}

function buildTextCost(model, usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || (inputTokens + outputTokens);
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens) || 0;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  const rates = ratesForTextModel(model);
  const billedCached = Math.min(cachedTokens, inputTokens);
  const billedInput = Math.max(0, inputTokens - billedCached);
  const estimatedUsd = (billedInput * rates.input + billedCached * rates.cachedInput + outputTokens * rates.output) / 1_000_000;
  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    textTokens: inputTokens || null,
    imageTokens: null,
    cachedTokens: billedCached || null,
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    at: new Date().toISOString(),
  };
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality || "medium");
  form.set("output_format", "png");
  if (background) form.set("background", background);
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image.data);
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const bodyText = await response.text();
  let result = {};
  try { result = bodyText ? JSON.parse(bodyText) : {}; }
  catch { result = {}; }
  if (!response.ok) throw openaiFailureError("image", response.status, bodyText, result);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw Object.assign(new Error("OpenAI response did not contain image data"), { detail: bodyText.slice(0, 2000) || null });
  return {
    bytes: Buffer.from(encoded, "base64"),
    cost: buildGenerationCost(model, result.usage),
  };
}

async function openAIAnalyze({ key, baseUrl, model, image, mime }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: [
          "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects.",
          "For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item.",
          "Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Category rules (important): upperbody = inner/main tops only (t-shirts, shirts, polos, blouses, thin sweaters worn as the base layer). wholebody_up = outer layers meant to go over a top (jackets, coats, blazers, zip-up fleeces, windbreakers, overshirts worn as outerwear). Never classify a jacket, coat, blazer, or zip-up outer layer as upperbody. lowerbody = pants, shorts, skirts. accessories_up = bags, hats, belts, jewelry, scarves, and other accessories. shoes = footwear.",
          "Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 3-8 lowercase hyphenated detail tags.",
          "Name style (important): Match this wardrobe's naming voice. Put the main colour first, then any distinctive fit/print/material, then the garment type. Use short natural Title Case English, not kebab-case or catalog jargon. Prefer everyday words like baggy, oversized, striped, graphic, ribbed, denim, linen, muslin, long-sleeved, quarter-zip, bermudas. Write T shirt with a space (not t-shirt). Keep brand or model names when clearly readable on watches, shoes, or labeled pieces. Good examples: Blue baggy jeans; Navy T shirt; Light blue striped long-sleeved shirt; Beige baggy chinos; Black tropical shirt; Navy bermudas; Beige linen shorts; Cream oversized shirt; Red ribbed shirt; Berkeley sweater; Navy quarter-zip sweater; Black baggy dress pants; Black oversized quarter-zip polo. Avoid names like navy t-shirt, light beige trousers, or short-sleeve button-up shirt.",
          "Detail tags must be searchable styling keywords. Prefer concrete wardrobe vocabulary over vague adjectives. When clearly visible, cover these dimensions:",
          "- colour family words (navy, cream, burgundy, olive, charcoal) that help search beyond the hex",
          "- formality (casual, smart-casual, formal, athletic, loungewear)",
          "- garment type (polo, shirt, t-shirt, blouse, sweater, jacket, jeans, chinos, trousers, shorts, skirt, sneakers, boots)",
          "- collar or neckline (collared, polo-collar, crewneck, v-neck, turtleneck, hooded, strapless)",
          "- fit or silhouette (slim, tailored, relaxed, oversized, boxy, wide-leg, straight, tapered, cropped)",
          "Also include distinctive construction when useful (short-sleeve, long-sleeve, button-front, zip-up, denim, striped, plaid, knit).",
          "Avoid filler tags like clothing, fashion, nice, stylish, top, or pants when a more specific type exists. Do not repeat the full item name as a tag.",
        ].join(" ") },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const bodyText = await response.text();
  let result = {};
  try { result = bodyText ? JSON.parse(bodyText) : {}; }
  catch { result = {}; }
  if (!response.ok) throw openaiFailureError("analysis", response.status, bodyText, result);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw Object.assign(new Error("OpenAI analysis returned no structured result"), { detail: bodyText.slice(0, 2000) || null });
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}

async function openAISuggestOutfit({ key, baseUrl, model, catalog, prompt }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: buildOutfitSuggestPrompt(catalog, prompt) },
      ] }],
      text: {
        format: {
          type: "json_schema",
          name: "outfit_suggestion",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              garmentIds: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 },
              requiredParts: {
                type: "array",
                items: { type: "string", enum: [...PARTS] },
                description: "Part ids explicitly named or clearly implied by the user's request (e.g. mentioning a jacket/coat means wholebody_up). Empty if the request doesn't name a specific part.",
              },
              name: { type: "string" },
              reason: { type: "string" },
            },
            required: ["garmentIds", "requiredParts", "name", "reason"],
          },
        },
      },
    }),
  });
  const bodyText = await response.text();
  let result = {};
  try { result = bodyText ? JSON.parse(bodyText) : {}; }
  catch { result = {}; }
  if (!response.ok) throw openaiFailureError("suggestion", response.status, bodyText, result);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw Object.assign(new Error("OpenAI outfit suggestion returned no structured result"), { detail: bodyText.slice(0, 2000) || null });
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.garmentIds)) throw new Error("OpenAI outfit suggestion returned an invalid garment list");
  return {
    garmentIds: parsed.garmentIds,
    requiredParts: Array.isArray(parsed.requiredParts) ? [...new Set(parsed.requiredParts.filter((part) => PARTS.has(part)))] : [],
    name: typeof parsed.name === "string" ? parsed.name.trim() : "",
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    cost: buildTextCost(model, result.usage),
  };
}

const ERROR_LOG_LIMIT = 100;

export function wardrobeImportApi(options = {}) {
  let root;
  let jobsDir;
  let importedFile;
  let libraryAssetDir;
  let outfitsFile;
  let outfitAssetDir;
  let modelsFile;
  let modelAssetDir;
  let errorsFile;
  const running = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  function modelImageUrl(id, version = Date.now()) {
    return `${MODEL_ASSET_ROOT}/${id}.png?v=${version}`;
  }

  function modelPreviewUrl(id, version = Date.now()) {
    return `${MODEL_ASSET_ROOT}/${id}-preview.png?v=${version}`;
  }

  function modelImagePath(id) {
    return path.join(modelAssetDir, `${id}.png`);
  }

  function modelPreviewPath(id) {
    return path.join(modelAssetDir, `${id}-preview.png`);
  }

  async function writeModelAssets(id, sourceBytes) {
    const png = await sharp(sourceBytes).png().toBuffer();
    await mkdir(modelAssetDir, { recursive: true });
    await writeFile(modelImagePath(id), png);
    const preview = await createCircularFacePreview(png, {
      key: setting("OPENAI_API_KEY").trim(),
      baseUrl: apiBaseUrl(),
      visionModel: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
    });
    await writeFile(modelPreviewPath(id), preview);
    const version = Date.now();
    return {
      image: modelImageUrl(id, version),
      preview: modelPreviewUrl(id, version),
    };
  }

  async function loadModelsDocument() {
    try {
      const document = JSON.parse(await readFile(modelsFile, "utf8"));
      const models = Array.isArray(document?.models) ? document.models : [];
      return {
        version: Number(document?.version) || 1,
        defaultModelId: typeof document?.defaultModelId === "string" ? document.defaultModelId : null,
        models,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, defaultModelId: null, models: [] };
      throw error;
    }
  }

  async function saveModelsDocument(document) {
    await atomicJson(modelsFile, {
      version: document.version || 1,
      defaultModelId: document.defaultModelId || null,
      models: document.models || [],
    });
  }

  async function legacyModelReferencePath() {
    const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
    return path.resolve(root, referenceSetting);
  }

  async function ensureModelPreview(model) {
    if (!model?.id) return model;
    try {
      await stat(modelPreviewPath(model.id));
      if (model.preview) return model;
      return { ...model, preview: modelPreviewUrl(model.id, Date.now()) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      // Backfill without OpenAI so listing models stays fast; add/replace generate face-aware previews.
      const source = await readFile(modelImagePath(model.id));
      const preview = await createCircularFacePreview(source);
      await writeFile(modelPreviewPath(model.id), preview);
      return { ...model, preview: modelPreviewUrl(model.id, Date.now()) };
    } catch {
      return model;
    }
  }

  async function ensureModelsSeeded() {
    await mkdir(modelAssetDir, { recursive: true });
    const document = await loadModelsDocument();
    if (document.models.length) {
      let changed = false;
      if (!document.defaultModelId || !document.models.some((model) => model.id === document.defaultModelId)) {
        document.defaultModelId = document.models[0].id;
        changed = true;
      }
      const models = [];
      for (const model of document.models) {
        const next = await ensureModelPreview(model);
        if (next.preview !== model.preview) changed = true;
        models.push(next);
      }
      document.models = models;
      if (changed) await saveModelsDocument(document);
      return document;
    }

    const legacyPath = await legacyModelReferencePath();
    try {
      if (!(await stat(legacyPath)).isFile()) return document;
    } catch (error) {
      if (error.code === "ENOENT") return document;
      throw error;
    }

    const id = `model-${randomUUID()}`;
    const now = new Date().toISOString();
    const legacyBytes = await readFile(legacyPath);
    const png = await sharp(legacyBytes).png().toBuffer();
    await writeFile(modelImagePath(id), png);
    const preview = await createCircularFacePreview(png);
    await writeFile(modelPreviewPath(id), preview);
    const version = Date.parse(now) || Date.now();
    const seeded = {
      version: 1,
      defaultModelId: id,
      models: [{
        id,
        name: "Default",
        image: modelImageUrl(id, version),
        preview: modelPreviewUrl(id, version),
        createdAt: now,
        updatedAt: now,
      }],
    };
    await saveModelsDocument(seeded);
    return seeded;
  }

  async function resolveModelFile(modelId) {
    const document = await ensureModelsSeeded();
    const model = document.models.find((entry) => entry.id === modelId);
    if (!model) {
      throw Object.assign(new Error(`Model not found: ${modelId}`), { status: 404 });
    }
    const filePath = modelImagePath(model.id);
    try {
      await stat(filePath);
      return { model, filePath, document };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Fall back to legacy env path for the default model only (migration safety).
    if (model.id === document.defaultModelId) {
      const legacyPath = await legacyModelReferencePath();
      try {
        await stat(legacyPath);
        return { model, filePath: legacyPath, document };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw Object.assign(new Error(`Model image missing for ${model.name || model.id}.`), { status: 409 });
  }

  async function resolveDefaultModelFile() {
    const document = await ensureModelsSeeded();
    if (!document.defaultModelId) {
      const legacyPath = await legacyModelReferencePath();
      try {
        await stat(legacyPath);
        return { model: null, filePath: legacyPath, document };
      } catch (error) {
        if (error.code === "ENOENT") {
          throw Object.assign(new Error("No default model is configured. Add a model in the Models tab."), { status: 503 });
        }
        throw error;
      }
    }
    return resolveModelFile(document.defaultModelId);
  }

  async function loadErrorsDocument() {
    try {
      const document = JSON.parse(await readFile(errorsFile, "utf8"));
      if (!document || !Array.isArray(document.errors)) return { version: 1, errors: [] };
      return { version: 1, errors: document.errors };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, errors: [] };
      throw error;
    }
  }

  async function saveErrorsDocument(document) {
    await atomicJson(errorsFile, { version: 1, errors: document.errors || [] });
  }

  async function logError({ source, title, message, detail = null, context = null, dedupeKey = null }) {
    const document = await loadErrorsDocument();
    if (dedupeKey) {
      const existing = document.errors.find((entry) => entry.dedupeKey === dedupeKey && entry.message === message);
      if (existing) return existing;
    }
    const entry = {
      id: `err-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      source,
      title,
      message: message || "Unknown error",
      detail: detail || null,
      context: context || null,
      dedupeKey: dedupeKey || null,
    };
    document.errors = [entry, ...document.errors].slice(0, ERROR_LOG_LIMIT);
    await saveErrorsDocument(document);
    console.error(`[wardrobe:${source}] ${title}: ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`);
    return entry;
  }

  async function logCaughtError(error, { source, title, context = null, dedupeKey = null }) {
    return logError({
      source,
      title,
      message: error?.message || String(error),
      detail: error?.detail || error?.responseBody || null,
      context,
      dedupeKey,
    });
  }

  async function setupStatus() {
    const hasApiKey = Boolean(setting("OPENAI_API_KEY").trim());
    const document = await ensureModelsSeeded();
    let hasModelReference = false;
    let defaultModel = null;
    if (document.defaultModelId) {
      defaultModel = document.models.find((model) => model.id === document.defaultModelId) || null;
      try {
        const { filePath } = await resolveDefaultModelFile();
        hasModelReference = (await stat(filePath)).isFile();
      } catch {
        hasModelReference = false;
      }
    } else {
      try {
        hasModelReference = (await stat(await legacyModelReferencePath())).isFile();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return {
      ready: hasApiKey && hasModelReference,
      hasApiKey,
      hasModelReference,
      hasDefaultModel: hasModelReference,
      defaultModelId: document.defaultModelId,
      defaultModelName: defaultModel?.name || null,
      modelReference: defaultModel?.image || setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"),
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  async function loadImported() {
    try { return JSON.parse(await readFile(importedFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function loadOutfitsDocument() {
    try {
      const document = JSON.parse(await readFile(outfitsFile, "utf8"));
      if (Array.isArray(document)) return { version: 1, outfits: document };
      const outfits = Array.isArray(document?.outfits) ? document.outfits : [];
      return { version: Number(document?.version) || 1, outfits };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, outfits: [] };
      throw error;
    }
  }

  async function saveOutfitsDocument(document) {
    await atomicJson(outfitsFile, { version: document.version || 1, outfits: document.outfits || [] });
  }

  async function updateOutfitRecord(id, updater) {
    const document = await loadOutfitsDocument();
    const index = document.outfits.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const updated = updater(document.outfits[index]);
    const next = [...document.outfits];
    next[index] = updated;
    await saveOutfitsDocument({ ...document, outfits: next });
    return updated;
  }

  async function persistImported(job, includeModeled = false) {
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    const sourceName = `${id}-source.png`;
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await copyFile(path.join(jobsDir, job.id, garmentSource), path.join(libraryAssetDir, garmentName));
    const cropSource = job.internal?.cropFile || "crop.png";
    try {
      await copyFile(path.join(jobsDir, job.id, cropSource), path.join(libraryAssetDir, sourceName));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl
        ? path.basename(new URL(job.stages.modeled.assetUrl, "http://localhost").pathname)
        : `modeled-${job.stages.modeled.attempts}.png`;
      await copyFile(path.join(jobsDir, job.id, modeledSource), path.join(libraryAssetDir, modeledName));
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = await loadImported();
    const existing = records.find((record) => record.id === id);
    const costs = {
      ...(existing?.costs || {}),
      ...(job.stages.garment?.cost ? { garment: job.stages.garment.cost } : {}),
      ...(includeModeled && job.stages.modeled?.cost ? { modeled: job.stages.modeled.cost } : {}),
    };
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      owned: metadata.owned !== false,
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
      ...(Object.keys(costs).length ? { costs } : {}),
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await atomicJson(importedFile, next);
    return record;
  }

  async function resolveGarmentSource(record) {
    const candidates = [];
    if (record.importJobId) {
      candidates.push(
        path.join(jobsDir, record.importJobId, "crop.png"),
        path.join(jobsDir, record.importJobId, "original.png"),
      );
    }
    candidates.push(
      path.join(libraryAssetDir, `${record.id}-source.png`),
      path.join(libraryAssetDir, `${record.id}-garment.png`),
    );
    if (typeof record.image === "string") {
      const filename = path.basename(record.image.split("?")[0]);
      if (filename) candidates.push(path.join(libraryAssetDir, filename));
    }
    for (const candidate of candidates) {
      try {
        return await readFile(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw Object.assign(new Error("No source image is available to regenerate this garment."), { status: 409 });
  }

  async function generateGarmentImageBytes(record, direction) {
    const key = setting("OPENAI_API_KEY");
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
    const sourceData = await resolveGarmentSource(record);
    const source = { data: sourceData, mime: "image/png", name: "source.png" };
    const chromaKeyUsed = chooseChromaKey(record.color);
    const basePrompt = options.garmentPrompt || buildGarmentPrompt(record, chromaKeyUsed);
    const prompt = direction ? `${basePrompt}\nUser regeneration direction: ${direction}` : basePrompt;
    const { bytes: rawBytes, cost } = await openAIEdit({
      key,
      baseUrl: apiBaseUrl(),
      model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
      quality: setting("OPENAI_IMAGE_QUALITY", "medium"),
      size: "1024x1024",
      images: [source],
      prompt,
    });
    const bytes = await removeChromaBackground(rawBytes, chromaKeyUsed);
    return { bytes, cost };
  }

  function generateGarmentForWardrobeItem(id, direction) {
    const lock = `wardrobe:${id}:garment`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      try {
        const records = await loadImported();
        const record = records.find((item) => item.id === id);
        if (!record) return;
        const { bytes, cost } = await generateGarmentImageBytes(record, direction);
        const assetName = `${id}-garment.png`;
        await writeFile(path.join(libraryAssetDir, assetName), bytes);
        const image = `${LIBRARY_ASSET_ROOT}/${assetName}?v=${Date.now()}`;
        await updateWardrobeRecord(id, (current) => ({
          ...current,
          image,
          thumbnail: image,
          garmentGeneration: null,
          costs: {
            ...(current.costs || {}),
            ...(cost ? { garment: cost } : {}),
          },
        }));
      } catch (error) {
        await updateWardrobeRecord(id, (current) => ({
          ...current,
          garmentGeneration: {
            status: "failed",
            error: error.message,
            startedAt: current.garmentGeneration?.startedAt || new Date().toISOString(),
          },
        })).catch(() => {});
        await logCaughtError(error, {
          source: "garment",
          title: "Garment regenerate failed",
          context: { wardrobeItemId: id },
          dedupeKey: `garment:${id}`,
        }).catch(() => {});
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function generateModeledImageBytes(record, direction, modelId = null) {
    const key = setting("OPENAI_API_KEY");
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
    const garmentFile = path.join(libraryAssetDir, `${record.id}-garment.png`);
    let garmentData;
    try {
      garmentData = await readFile(garmentFile);
    } catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error("This item's garment image is missing, so a modeled photo cannot be generated."), { status: 409 });
      throw error;
    }
    const resolved = modelId
      ? await resolveModelFile(modelId)
      : await resolveDefaultModelFile();
    let modelData;
    try {
      modelData = await readFile(resolved.filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(modelId
          ? "Selected model reference image is missing. Replace it in the Models tab."
          : "Default model reference image is missing. Add or replace a model in the Models tab.");
      }
      throw error;
    }
    const garment = { data: garmentData, mime: "image/png", name: "garment.png" };
    const model = { data: modelData, mime: "image/png", name: "model.png" };
    const basePrompt = options.modeledPrompt || buildModeledPrompt();
    const prompt = direction ? `${basePrompt}\nUser regeneration direction: ${direction}` : basePrompt;
    return openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "medium"), size: "1536x1024", images: [model, garment], prompt });
  }

  async function updateWardrobeRecord(id, updater) {
    const records = await loadImported();
    const index = records.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const updated = updater(records[index]);
    const next = [...records];
    next[index] = updated;
    await atomicJson(importedFile, next);
    return updated;
  }

  function generateModeledForWardrobeItem(id, direction, modelId = null) {
    const lock = `wardrobe:${id}:modeled`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      try {
        const records = await loadImported();
        const record = records.find((item) => item.id === id);
        if (!record) return;
        const { bytes, cost } = await generateModeledImageBytes(record, direction, modelId);
        const assetName = `${id}-modeled.png`;
        await writeFile(path.join(libraryAssetDir, assetName), bytes);
        const modeledImage = `${LIBRARY_ASSET_ROOT}/${assetName}?v=${Date.now()}`;
        await updateWardrobeRecord(id, (current) => ({
          ...current,
          modeledImage,
          modeledGeneration: null,
          costs: {
            ...(current.costs || {}),
            ...(cost ? { modeled: cost } : {}),
          },
        }));
      } catch (error) {
        await updateWardrobeRecord(id, (current) => ({
          ...current,
          modeledGeneration: { status: "failed", error: error.message, startedAt: current.modeledGeneration?.startedAt || new Date().toISOString() },
        })).catch(() => {});
        await logCaughtError(error, {
          source: "modeled",
          title: "Modeled photo failed",
          context: { wardrobeItemId: id },
          dedupeKey: `modeled:${id}`,
        }).catch(() => {});
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function resolveGarmentAsset(record) {
    const candidates = [
      path.join(libraryAssetDir, `${record.id}-garment.png`),
    ];
    if (typeof record.image === "string") {
      const filename = path.basename(record.image.split("?")[0]);
      if (filename) candidates.push(path.join(libraryAssetDir, filename));
    }
    for (const candidate of candidates) {
      try {
        return await readFile(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw Object.assign(new Error(`Garment image missing for ${record.name || record.id}.`), { status: 409 });
  }

  async function resolveOutfitLooks(outfit, records) {
    const looksInput = Array.isArray(outfit.looks) && outfit.looks.length
      ? outfit.looks
      : [{
          modelId: Array.isArray(outfit.modelIds) ? outfit.modelIds[0] : null,
          garmentIds: outfit.garmentIds || [],
        }];

    const looks = [];
    for (const look of looksInput) {
      const garmentIds = Array.isArray(look.garmentIds) ? look.garmentIds : [];
      const garments = garmentIds
        .map((garmentId) => records.find((item) => item.id === garmentId))
        .filter(Boolean);
      if (garments.length < 2) {
        throw new Error("This outfit is missing garments from the wardrobe.");
      }
      let modelId = typeof look.modelId === "string" ? look.modelId : null;
      let modelFile;
      if (modelId) {
        modelFile = await resolveModelFile(modelId);
      } else {
        modelFile = await resolveDefaultModelFile();
        modelId = modelFile.model?.id || null;
      }
      looks.push({
        modelId,
        model: modelFile.model,
        modelPath: modelFile.filePath,
        garments: sortGarmentsByPart(garments),
      });
    }
    return looks;
  }

  async function generateOutfitImageBytes(outfit, records) {
    const key = setting("OPENAI_API_KEY");
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
    const looks = await resolveOutfitLooks(outfit, records);
    const images = [];
    for (const [lookIndex, look] of looks.entries()) {
      let modelData;
      try {
        modelData = await readFile(look.modelPath);
      } catch (error) {
        if (error.code === "ENOENT") throw new Error(`Model reference image is missing for ${look.model?.name || look.modelId || "model"}.`);
        throw error;
      }
      images.push({ data: modelData, mime: "image/png", name: `model-${lookIndex + 1}.png` });
      for (const [garmentIndex, garment] of look.garments.entries()) {
        images.push({
          data: await resolveGarmentAsset(garment),
          mime: "image/png",
          name: `look-${lookIndex + 1}-garment-${garmentIndex + 1}.png`,
        });
      }
    }

    const direction = outfitGenerationDirection(outfit);
    let prompt;
    if (looks.length >= 2) {
      prompt = options.duoOutfitPrompt || buildDuoOutfitPrompt(looks.map((look) => ({
        modelName: look.model?.name || "Model",
        garments: look.garments,
      })), {
        name: outfit.name,
        setting: outfit.setting || DEFAULT_OUTFIT_SETTING,
        prompt: direction,
      });
    } else {
      const ordered = looks[0].garments;
      prompt = options.outfitPrompt || buildOutfitPrompt(ordered, {
        name: outfit.name,
        setting: outfit.setting || DEFAULT_OUTFIT_SETTING,
        prompt: direction,
      });
    }

    return openAIEdit({
      key,
      baseUrl: apiBaseUrl(),
      model: setting("OPENAI_OUTFIT_MODEL", setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2"))),
      quality: setting("OPENAI_IMAGE_QUALITY", "medium"),
      size: "1024x1024",
      images,
      prompt,
    });
  }

  function generateOutfitForId(id) {
    const lock = `outfit:${id}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      try {
        const document = await loadOutfitsDocument();
        const outfit = document.outfits.find((item) => item.id === id);
        if (!outfit) return;
        const records = await loadImported();
        const { bytes, cost } = await generateOutfitImageBytes(outfit, records);
        await mkdir(outfitAssetDir, { recursive: true });
        const assetName = `${id}.png`;
        await writeFile(path.join(outfitAssetDir, assetName), bytes);
        const image = `${OUTFIT_ASSET_ROOT}/${assetName}?v=${Date.now()}`;
        await updateOutfitRecord(id, (current) => ({
          ...current,
          image,
          status: "ready",
          error: null,
          cost: cost || current.cost || null,
          completedAt: new Date().toISOString(),
        }));
      } catch (error) {
        let outfitName = id;
        await updateOutfitRecord(id, (current) => {
          outfitName = current.name || id;
          return {
            ...current,
            status: "failed",
            error: error.message,
            completedAt: new Date().toISOString(),
          };
        }).catch(() => {});
        await logCaughtError(error, {
          source: "outfit",
          title: "Outfit generation failed",
          context: { outfitId: id, outfitName },
          dedupeKey: `outfit:${id}:${error.message}`,
        }).catch(() => {});
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const key = setting("OPENAI_API_KEY");
        if (!key) throw new Error("OPENAI_API_KEY is not configured");
        const sourceFile = stageName === "garment" && current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };
        let bytes;
        let cost = null;
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, chromaKeyUsed);
          ({ bytes, cost } = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "medium"), size: "1024x1024", images: [original], prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt }));
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await writeFile(path.join(dir, rawName), bytes);
          failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
        } else {
          const garmentName = current.stages.garment.assetUrl
            ? path.basename(new URL(current.stages.garment.assetUrl, "http://localhost").pathname)
            : `garment-${current.stages.garment.attempts}.png`;
          const garmentFile = path.join(dir, garmentName);
          const garment = { data: await readFile(garmentFile), mime: "image/png", name: "garment.png" };
          const selectedModelId = typeof current.stages.modeled?.modelId === "string" && current.stages.modeled.modelId.trim()
            ? current.stages.modeled.modelId.trim()
            : null;
          const resolvedModel = selectedModelId
            ? await resolveModelFile(selectedModelId)
            : await resolveDefaultModelFile();
          let modelData;
          try {
            modelData = await readFile(resolvedModel.filePath);
          } catch (error) {
            if (error.code === "ENOENT") {
              throw new Error(selectedModelId
                ? "Selected model reference image is missing. Replace it in the Models tab."
                : "Default model reference image is missing. Add or replace a model in the Models tab.");
            }
            throw error;
          }
          const model = { data: modelData, mime: "image/png", name: "model.png" };
          const basePrompt = options.modeledPrompt || buildModeledPrompt();
          ({ bytes, cost } = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "medium"), size: "1536x1024", images: [model, garment], prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt }));
        }
        await writeFile(output, bytes);
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        fresh.stages[stageName].cost = cost;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
        await logCaughtError(error, {
          source: "import",
          title: `Import ${stageName} failed`,
          context: { jobId: current.id, stage: stageName },
          dedupeKey: `import:${current.id}:${stageName}:${error.message}`,
        }).catch(() => {});
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    try {
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        return json(res, 200, await loadImported());
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        return json(res, 200, await setupStatus());
      }
      if (url.pathname === "/api/import/models" && req.method === "GET") {
        const document = await ensureModelsSeeded();
        return json(res, 200, {
          defaultModelId: document.defaultModelId,
          models: [...document.models].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
        });
      }
      if (url.pathname === "/api/import/models" && req.method === "POST") {
        const input = await body(req);
        const { data } = decodeImage(input);
        const name = typeof input.name === "string" && input.name.trim()
          ? input.name.trim().slice(0, 120)
          : "New model";
        const document = await ensureModelsSeeded();
        const id = `model-${randomUUID()}`;
        const now = new Date().toISOString();
        const assets = await writeModelAssets(id, data);
        const model = {
          id,
          name,
          image: assets.image,
          preview: assets.preview,
          createdAt: now,
          updatedAt: now,
        };
        const next = {
          ...document,
          defaultModelId: document.defaultModelId || id,
          models: [...document.models, model],
        };
        await saveModelsDocument(next);
        return json(res, 201, { defaultModelId: next.defaultModelId, model });
      }
      const modelMatch = url.pathname.match(/^\/api\/import\/models\/(model-[a-f0-9-]{36})$/i);
      if (modelMatch && req.method === "PATCH") {
        const id = modelMatch[1];
        const input = await body(req);
        const document = await ensureModelsSeeded();
        const index = document.models.findIndex((model) => model.id === id);
        if (index === -1) return json(res, 404, { error: "Model not found" });
        const current = document.models[index];
        let name = current.name;
        if (typeof input.name === "string") {
          name = input.name.trim().slice(0, 120);
          if (!name) return json(res, 400, { error: "Model name cannot be empty." });
        }
        const now = new Date().toISOString();
        let image = current.image;
        let preview = current.preview || null;
        if (input.imageDataUrl || input.imageBase64) {
          const { data } = decodeImage(input);
          const assets = await writeModelAssets(id, data);
          image = assets.image;
          preview = assets.preview;
        }
        const updated = { ...current, name, image, preview, updatedAt: now };
        const models = [...document.models];
        models[index] = updated;
        let defaultModelId = document.defaultModelId;
        if (input.setDefault === true) defaultModelId = id;
        await saveModelsDocument({ ...document, defaultModelId, models });
        return json(res, 200, { defaultModelId, model: updated });
      }
      if (modelMatch && req.method === "DELETE") {
        const id = modelMatch[1];
        const document = await ensureModelsSeeded();
        if (document.models.length <= 1) {
          return json(res, 400, { error: "Keep at least one model in the library." });
        }
        const nextModels = document.models.filter((model) => model.id !== id);
        if (nextModels.length === document.models.length) return json(res, 404, { error: "Model not found" });
        let defaultModelId = document.defaultModelId;
        if (defaultModelId === id) defaultModelId = nextModels[0].id;
        await saveModelsDocument({ ...document, defaultModelId, models: nextModels });
        await Promise.all([
          rm(modelImagePath(id), { force: true }),
          rm(modelPreviewPath(id), { force: true }),
        ]);
        return json(res, 200, { deleted: true, id, defaultModelId });
      }
      const modelAssetMatch = url.pathname.match(/^\/api\/import\/model-images\/([\w.-]+)$/i);
      if (modelAssetMatch && req.method === "GET") {
        const file = path.join(modelAssetDir, path.basename(modelAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      if (url.pathname === "/api/import/outfits" && req.method === "GET") {
        const document = await loadOutfitsDocument();
        const outfits = [...document.outfits]
          .map((outfit) => ({
            ...outfit,
            tags: resolveOutfitTags(outfit),
          }))
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return json(res, 200, outfits);
      }
      if (url.pathname === "/api/import/outfits/suggest" && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.hasApiKey) {
          return json(res, 503, { error: "Setup required: add OPENAI_API_KEY in .env, then restart the app." });
        }
        const input = await body(req, 64 * 1024);
        const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 500) : "";
        if (!prompt) {
          return json(res, 400, { error: "Enter a styling prompt to suggest an outfit." });
        }
        const records = await loadImported();
        // AI outfit picks are limited to pieces you own — wishlist / not-owned items stay out of the catalog.
        const ownedRecords = records.filter((item) => item.owned !== false);
        if (ownedRecords.length < 2) {
          return json(res, 400, { error: "Add at least two owned garments to your wardrobe first." });
        }
        const catalog = ownedRecords.map((item) => ({
          id: item.id,
          name: item.name,
          part: item.part,
          color: item.color || null,
          secondaryColor: item.secondaryColor || null,
          palette: Array.isArray(item.palette) ? item.palette : [],
          tags: Array.isArray(item.tags)
            ? item.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim())
            : [],
        }));
        const byId = new Map(ownedRecords.map((item) => [item.id, item]));

        const key = setting("OPENAI_API_KEY");
        const model = setting("OPENAI_VISION_MODEL", "gpt-5.4-mini");
        const baseUrl = apiBaseUrl();
        let suggestion;
        try {
          suggestion = await openAISuggestOutfit({ key, baseUrl, model, catalog, prompt });
        } catch (error) {
          return json(res, error.status || 502, { error: error.message || "Could not suggest an outfit." });
        }
        const requiredParts = suggestion.requiredParts.filter((part) =>
          ownedRecords.some((item) => item.part === part),
        );

        const garmentIds = [...new Set(
          (suggestion.garmentIds || [])
            .filter((id) => typeof id === "string" && id.trim())
            .map((id) => id.trim()),
        )];
        const garments = [];
        const seenParts = new Set();
        for (const garmentId of garmentIds) {
          const record = byId.get(garmentId);
          if (!record) {
            // Skip unknown or not-owned ids the model may invent; do not fail the whole suggestion.
            continue;
          }
          if (record.part !== "accessories_up") {
            if (seenParts.has(record.part)) continue;
            seenParts.add(record.part);
          }
          garments.push(record);
        }
        if (garments.length < 2) {
          return json(res, 502, { error: "The model did not return enough owned garments for an outfit." });
        }

        // Safety net: if the model listed a required part but its own garmentIds omitted it, fill the gap deterministically.
        const withRequired = ensureRequiredParts(garments, requiredParts, ownedRecords, prompt);
        // Hex pairing safety net: avoid near-identical navy/navy top + outer layer stacks.
        const ordered = improveOutfitColorPairing(withRequired, ownedRecords, prompt);
        const missingRequired = requiredParts.filter((part) => !ordered.some((item) => item.part === part));
        if (missingRequired.length) {
          const missingLabels = missingRequired.map((part) => PART_LABEL[part] || part).join(", ");
          return json(res, 502, { error: `No ${missingLabels.toLowerCase()} available to complete that request.` });
        }

        return json(res, 200, {
          garmentIds: ordered.map((item) => item.id),
          name: (suggestion.name || outfitNameFromGarments(ordered)).slice(0, 120),
          reason: (suggestion.reason || "").slice(0, 400),
          ...(suggestion.cost ? { cost: suggestion.cost } : {}),
        });
      }
      if (url.pathname === "/api/import/outfits" && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && "a default model in the Models tab",
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const modelsDocument = await ensureModelsSeeded();
        const defaultModelId = modelsDocument.defaultModelId;
        const looksInput = Array.isArray(input.looks) && input.looks.length
          ? input.looks
          : [{
              modelId: typeof input.modelId === "string" ? input.modelId : defaultModelId,
              garmentIds: Array.isArray(input.garmentIds) ? input.garmentIds : [],
            }];
        if (looksInput.length < 1 || looksInput.length > 2) {
          return json(res, 400, { error: "Choose one or two models for an outfit." });
        }

        const records = await loadImported();
        const looks = [];
        const modelIds = [];
        for (const lookInput of looksInput) {
          const modelId = typeof lookInput.modelId === "string" && lookInput.modelId.trim()
            ? lookInput.modelId.trim()
            : defaultModelId;
          if (!modelId) return json(res, 400, { error: "Add a default model before generating outfits." });
          if (modelIds.includes(modelId)) {
            return json(res, 400, { error: "Choose two different models for a duo outfit." });
          }
          const model = modelsDocument.models.find((entry) => entry.id === modelId);
          if (!model) return json(res, 404, { error: `Model not found: ${modelId}` });
          try {
            await resolveModelFile(modelId);
          } catch (error) {
            return json(res, error.status || 409, { error: error.message });
          }

          const garmentIds = Array.isArray(lookInput.garmentIds)
            ? [...new Set(lookInput.garmentIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
            : [];
          if (garmentIds.length < 2) {
            return json(res, 400, { error: looksInput.length > 1
              ? `Add at least two garments for ${model.name || "each model"}.`
              : "Add at least two garments to generate an outfit." });
          }
          const garments = [];
          const seenParts = new Set();
          for (const garmentId of garmentIds) {
            const record = records.find((item) => item.id === garmentId);
            if (!record) return json(res, 404, { error: `Wardrobe item not found: ${garmentId}` });
            if (record.part !== "accessories_up") {
              if (seenParts.has(record.part)) {
                return json(res, 400, { error: `Only one ${PART_LABEL[record.part] || "item"} can be added.` });
              }
              seenParts.add(record.part);
            }
            garments.push(record);
          }
          for (const garment of garments) {
            try {
              await resolveGarmentAsset(garment);
            } catch (error) {
              return json(res, error.status || 409, { error: error.message });
            }
          }
          const ordered = sortGarmentsByPart(garments);
          modelIds.push(modelId);
          looks.push({
            modelId,
            garmentIds: ordered.map((item) => item.id),
            garments: ordered,
            modelName: model.name,
          });
        }

        const flatGarments = looks.flatMap((look) => look.garments);
        const id = `outfit-${randomUUID()}`;
        const name = looks.length > 1
          ? looks.map((look) => `${look.modelName}: ${outfitNameFromGarments(look.garments)}`).join(" · ")
          : outfitNameFromGarments(looks[0].garments);
        const createdAt = new Date().toISOString();
        const tags = input.tags !== undefined ? normalizeTags(input.tags) : [];
        const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
        const outfit = {
          id,
          name: name.slice(0, 160),
          modelIds,
          looks: looks.map((look) => ({ modelId: look.modelId, garmentIds: look.garmentIds })),
          garmentIds: [...new Set(flatGarments.map((item) => item.id))],
          setting: DEFAULT_OUTFIT_SETTING,
          tags,
          prompt,
          image: null,
          status: "processing",
          error: null,
          createdAt,
        };
        const document = await loadOutfitsDocument();
        await saveOutfitsDocument({ ...document, outfits: [...document.outfits, outfit] });
        void generateOutfitForId(id);
        return json(res, 202, outfit);
      }
      const outfitMatch = url.pathname.match(/^\/api\/import\/outfits\/(outfit-[a-f0-9-]{36})$/i);
      if (outfitMatch && req.method === "PATCH") {
        const id = outfitMatch[1];
        const input = await body(req);
        if (typeof input.name !== "string") return json(res, 400, { error: "name is required." });
        const name = input.name.trim().slice(0, 120);
        if (!name) return json(res, 400, { error: "Outfit name cannot be empty." });
        const hasTags = input.tags !== undefined;
        const tags = hasTags ? normalizeTags(input.tags) : null;
        const updated = await updateOutfitRecord(id, (current) => ({
          ...current,
          name,
          ...(hasTags ? { tags } : {}),
        }));
        if (!updated) return json(res, 404, { error: "Outfit not found" });
        return json(res, 200, updated);
      }
      if (outfitMatch && req.method === "DELETE") {
        const id = outfitMatch[1];
        const document = await loadOutfitsDocument();
        const next = document.outfits.filter((item) => item.id !== id);
        if (next.length === document.outfits.length) return json(res, 404, { error: "Outfit not found" });
        await saveOutfitsDocument({ ...document, outfits: next });
        await rm(path.join(outfitAssetDir, `${id}.png`), { force: true });
        return json(res, 200, { deleted: true, id });
      }
      const outfitAssetMatch = url.pathname.match(/^\/api\/import\/outfit-images\/([\w.-]+)$/i);
      if (outfitAssetMatch && req.method === "GET") {
        const file = path.join(outfitAssetDir, path.basename(outfitAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      const wardrobeItemMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeItemMatch && req.method === "GET") {
        const records = await loadImported();
        const record = records.find((item) => item.id === wardrobeItemMatch[1]);
        if (!record) return json(res, 404, { error: "Wardrobe item not found" });
        return json(res, 200, record);
      }
      if (wardrobeItemMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = wardrobeItemMatch[1];
        const input = await body(req);
        const updated = await updateWardrobeRecord(id, (current) => normalizeWardrobePatch(current, input));
        if (!updated) return json(res, 404, { error: "Wardrobe item not found" });
        return json(res, 200, updated);
      }
      if (wardrobeItemMatch && req.method === "DELETE") {
        const id = wardrobeItemMatch[1];
        const records = await loadImported();
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Imported wardrobe item not found" });
        await atomicJson(importedFile, next);
        await Promise.all([
          rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }),
          rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }),
          rm(path.join(libraryAssetDir, `${id}-source.png`), { force: true }),
        ]);
        return json(res, 200, { deleted: true, id });
      }
      const wardrobeGarmentMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/garment$/i);
      if (wardrobeGarmentMatch && req.method === "POST") {
        const id = wardrobeGarmentMatch[1];
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && "a default model in the Models tab",
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const records = await loadImported();
        const record = records.find((item) => item.id === id);
        if (!record) return json(res, 404, { error: "Wardrobe item not found" });
        if (record.garmentGeneration?.status === "processing") return json(res, 202, record);
        const input = await body(req);
        const direction = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) : "";
        const marked = await updateWardrobeRecord(id, (current) => ({
          ...current,
          garmentGeneration: { status: "processing", error: null, startedAt: new Date().toISOString() },
        }));
        void generateGarmentForWardrobeItem(id, direction);
        return json(res, 202, marked);
      }
      const wardrobeModeledMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/modeled$/i);
      if (wardrobeModeledMatch && req.method === "POST") {
        const id = wardrobeModeledMatch[1];
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && "a default model in the Models tab",
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const records = await loadImported();
        const record = records.find((item) => item.id === id);
        if (!record) return json(res, 404, { error: "Wardrobe item not found" });
        if (record.modeledGeneration?.status === "processing") return json(res, 202, record);
        const input = await body(req);
        const direction = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) : "";
        const modelsDocument = await ensureModelsSeeded();
        const requestedModelId = typeof input.modelId === "string" && input.modelId.trim()
          ? input.modelId.trim()
          : modelsDocument.defaultModelId;
        if (!requestedModelId) {
          return json(res, 400, { error: "Add a model before generating a modeled photo." });
        }
        if (!modelsDocument.models.some((model) => model.id === requestedModelId)) {
          return json(res, 404, { error: `Model not found: ${requestedModelId}` });
        }
        try {
          await resolveModelFile(requestedModelId);
        } catch (error) {
          return json(res, error.status || 409, { error: error.message });
        }
        const marked = await updateWardrobeRecord(id, (current) => ({
          ...current,
          modeledGeneration: { status: "processing", error: null, startedAt: new Date().toISOString() },
        }));
        void generateModeledForWardrobeItem(id, direction, requestedModelId);
        return json(res, 202, marked);
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(jobsDir, assetMatch[1], path.basename(assetMatch[2]));
        await stat(file);
        res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }
      if (url.pathname === API_ROOT && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && "a default model in the Models tab",
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const key = setting("OPENAI_API_KEY");
        const detected = (await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const dir = path.join(jobsDir, id); await mkdir(dir, { recursive: true });
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await writeFile(path.join(dir, originalFile), normalizedImage);
          await writeFile(path.join(dir, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job); jobs.push(publicJob(job));
        }
        return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
      }
      if (url.pathname === API_ROOT && req.method === "GET") {
        const ids = await readdir(jobsDir).catch(() => []);
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => rm(path.join(jobsDir, job.id), { recursive: true, force: true })));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, publicJob(job));
      if (!action && req.method === "DELETE") {
        await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const source = await readFile(path.join(jobsDir, job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          if (stageName === "modeled") {
            const modelsDocument = await ensureModelsSeeded();
            const requestedModelId = typeof input.modelId === "string" && input.modelId.trim()
              ? input.modelId.trim()
              : (job.stages.modeled.modelId || modelsDocument.defaultModelId);
            if (!requestedModelId) throw Object.assign(new Error("Add a model before generating a modeled photo."), { status: 400 });
            if (!modelsDocument.models.some((model) => model.id === requestedModelId)) {
              throw Object.assign(new Error(`Model not found: ${requestedModelId}`), { status: 404 });
            }
            await resolveModelFile(requestedModelId);
            job.stages.modeled.modelId = requestedModelId;
          }
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          void generate(job, stageName);
          return json(res, 202, publicJob(job));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        if (stageName === "garment" && decision === "approve") {
          const input = await body(req).catch(() => ({}));
          const modelsDocument = await ensureModelsSeeded();
          const requestedModelId = typeof input.modelId === "string" && input.modelId.trim()
            ? input.modelId.trim()
            : (job.stages.modeled.modelId || modelsDocument.defaultModelId);
          if (!requestedModelId) throw Object.assign(new Error("Choose a model before approving the garment."), { status: 400 });
          if (!modelsDocument.models.some((model) => model.id === requestedModelId)) {
            throw Object.assign(new Error(`Model not found: ${requestedModelId}`), { status: 404 });
          }
          await resolveModelFile(requestedModelId);
          job.stages.modeled.modelId = requestedModelId;
        }
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending";
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        await saveJob(job);
        if (decision === "approve" && stageName !== "crop") {
          try {
            await persistImported(job, stageName === "modeled");
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job);
            throw error;
          }
        }
        if (decision === "reject") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        if (startGarment) void generate(job, "garment");
        if (startModeled) void generate(job, "modeled");
        const response = publicJob(job);
        if (job.status === "complete") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(process.env.NODE_ENV === "development" && statusCode === 500 ? { detail: error.message } : {}) });
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      const dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      jobsDir = path.join(dataDir, "jobs");
      importedFile = path.join(dataDir, "library.json");
      libraryAssetDir = path.join(dataDir, "imported");
      outfitsFile = path.join(dataDir, "outfits.json");
      outfitAssetDir = path.join(dataDir, "outfit-images");
      modelsFile = path.join(dataDir, "models.json");
      modelAssetDir = path.join(dataDir, "model-images");
      errorsFile = path.join(dataDir, "errors.json");
      await mkdir(jobsDir, { recursive: true });
      await mkdir(libraryAssetDir, { recursive: true });
      await mkdir(outfitAssetDir, { recursive: true });
      await mkdir(modelAssetDir, { recursive: true });
      await ensureModelsSeeded();
      const importedRecords = await loadImported();
      let importedInterrupted = false;
      const sweptRecords = importedRecords.map((record) => {
        if (record.modeledGeneration?.status !== "processing") return record;
        importedInterrupted = true;
        return { ...record, modeledGeneration: { status: "failed", error: "Generation was interrupted when the app restarted. Try again.", startedAt: record.modeledGeneration.startedAt } };
      });
      if (importedInterrupted) await atomicJson(importedFile, sweptRecords);
      const outfitsDocument = await loadOutfitsDocument();
      let outfitsInterrupted = false;
      const sweptOutfits = outfitsDocument.outfits.map((outfit) => {
        if (outfit.status !== "processing") return outfit;
        outfitsInterrupted = true;
        return {
          ...outfit,
          status: "failed",
          error: "Generation was interrupted when the app restarted. Try again.",
          completedAt: new Date().toISOString(),
        };
      });
      if (outfitsInterrupted) await saveOutfitsDocument({ ...outfitsDocument, outfits: sweptOutfits });
      for (const outfit of (outfitsInterrupted ? sweptOutfits : outfitsDocument.outfits)) {
        if (outfit.status !== "failed" || !outfit.error) continue;
        await logError({
          source: "outfit",
          title: "Outfit generation failed",
          message: outfit.error,
          context: { outfitId: outfit.id, outfitName: outfit.name || outfit.id },
          dedupeKey: `outfit:${outfit.id}:${outfit.error}`,
        }).catch(() => {});
      }
      for (const record of (importedInterrupted ? sweptRecords : importedRecords)) {
        if (record.modeledGeneration?.status !== "failed" || !record.modeledGeneration.error) continue;
        await logError({
          source: "modeled",
          title: "Modeled photo failed",
          message: record.modeledGeneration.error,
          context: { wardrobeItemId: record.id, name: record.name || record.id },
          dedupeKey: `modeled:${record.id}:${record.modeledGeneration.error}`,
        }).catch(() => {});
      }
      const ids = await readdir(jobsDir).catch(() => []);
      for (const id of ids) {
        const job = await loadJob(id);
        if (!job) continue;
        if (job.status === "complete") {
          try {
            await persistImported(job, true);
            await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          } catch (error) {
            job.status = "active";
            job.stages.modeled.status = "review";
            job.stages.modeled.decision = null;
            job.stages.modeled.error = null;
            await saveJob(job);
          }
          continue;
        }
        if (job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected") {
          await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          continue;
        }
        if (job.stages.crop && job.stages.crop.status !== "approved") continue;
        if (["processing", "queued"].includes(job.stages.garment.status)) {
          job.stages.garment.status = "pending";
          await saveJob(job);
          void generate(job, "garment");
        } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
          job.stages.modeled.status = "pending";
          await saveJob(job);
          void generate(job, "modeled");
        }
      }
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
