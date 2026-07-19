/** Runtime image-generation prompts used by the wardrobe import API. */

export const PART_ORDER = ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"];

export const PART_ROLE = {
  upperbody: "top",
  wholebody_up: "outer-layer",
  lowerbody: "bottom",
  accessories_up: "accessory",
  shoes: "shoe",
};

export const PART_LABEL = {
  upperbody: "Top",
  wholebody_up: "Jacket",
  lowerbody: "Bottom",
  accessories_up: "Accessory",
  shoes: "Shoes",
};

export const DEFAULT_OUTFIT_SETTING = "a quiet warm-stone courtyard with restrained greenery";

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

export function buildModeledPrompt() {
  return "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";
}

export function sortGarmentsByPart(garments) {
  return [...garments].sort((a, b) => {
    const orderDifference = (PART_ORDER.indexOf(a.part) === -1 ? 99 : PART_ORDER.indexOf(a.part))
      - (PART_ORDER.indexOf(b.part) === -1 ? 99 : PART_ORDER.indexOf(b.part));
    if (orderDifference) return orderDifference;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

export function outfitNameFromGarments(garments = []) {
  return sortGarmentsByPart(garments)
    .map((item) => item.name?.trim() || PART_LABEL[item.part] || "Piece")
    .join(" + ");
}

export function buildOutfitPrompt(garments = [], options = {}) {
  const ordered = sortGarmentsByPart(garments);
  const name = options.name || outfitNameFromGarments(ordered) || "Outfit";
  const setting = options.setting || DEFAULT_OUTFIT_SETTING;
  const hasLayeredLook = ordered.some((item) => item.part === "upperbody")
    && ordered.some((item) => item.part === "wholebody_up");
  const hasShoes = ordered.some((item) => item.part === "shoes");

  const imageLines = [
    "Image 1: identity reference for the exact person to preserve.",
    ...ordered.map((item, index) => {
      const role = PART_ROLE[item.part] || "garment";
      const label = item.name || PART_LABEL[item.part] || "garment";
      const outerNote = item.part === "wholebody_up"
        ? " Preserve its real construction and closure exactly; never invent a zipper, buttons, placket, or opening."
        : "";
      return `Image ${index + 2}: exact ${role} reference (${label}).${outerNote}`;
    }),
  ];

  const garmentList = ordered
    .map((item) => `${PART_ROLE[item.part] || "garment"} (${item.name || PART_LABEL[item.part] || "piece"})`)
    .join(", ");

  const shoesClause = hasShoes
    ? ""
    : " Plain understated shoes and invisible basics such as socks are allowed only where needed when no shoe reference is provided.";

  const layeredClause = hasLayeredLook
    ? "\n\nLayered-look clause: Layer the exact inner top and outer layer naturally so both remain visibly identifiable. First inspect the outer reference. If it has a real full front button or zipper closure, it may be worn naturally open or partly open using only that closure. If it is a pullover or has no full front opening, keep it closed exactly as designed and reveal the inner top only at its real collar or neckline, sleeve or cuff edge, or a natural 2–4 cm untucked hem below the outer layer. Never invent, add, split, unzip, unbutton, or simulate a closure. Keep the outer garment at its true length even when it overlaps the waistband."
    : "";

  const base = `Use case: identity-preserve
Asset type: square outfit gallery photograph

${imageLines.join("\n")}

Primary request: Create a professional square editorial fashion photograph of the person from Image 1 wearing all of the exact referenced garments, and only those garments.

Outfit: ${name}
Scene/backdrop: ${setting}.

Subject: Preserve the same person's recognizable face, hair, age, build, skin texture, and body proportions. Dress them in every exact referenced garment: ${garmentList}.${shoesClause} Do not add, replace, or invent any other visible clothing or accessory. Every selected garment must remain clearly visible and identifiable.

Style/medium: Photorealistic natural editorial fashion campaign with authentic skin and fabric texture and no synthetic AI polish.

Composition/framing: Square 1:1 image. Show the complete person and outfit from head through shoes. Keep the person centered and occupying most of the frame with modest breathing room. Use a relaxed, mostly front-facing pose with arms away from the torso so every item remains readable.

Lighting/mood: Warm professional natural light, realistic shadows, and restrained editorial color grading.

Garment fidelity: Preserve every referenced garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, distinctive details, and real closure construction. Keep each selected garment recognizable without changing its natural length, tuck, or construction.${layeredClause}

Avoid: Completely hidden selected garments, invented zippers, buttons, openings or plackets, unnatural layering, extra layers, hats, bags, scarves, jewelry, visible unreferenced undershirts, crossed arms, hands blocking clothing, garment redesign, changed logos or text, cropped feet, extra people, text overlays, watermarks, studio cutout appearance, or synthetic AI polish.`;

  const direction = typeof options.prompt === "string" ? options.prompt.trim() : "";
  return direction ? `${base}\n\nUser direction: ${direction}` : base;
}

function catalogTags(item) {
  return Array.isArray(item.tags)
    ? item.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim().toLowerCase())
    : [];
}

function parseHexRgb(hex) {
  if (typeof hex !== "string") return null;
  const match = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/**
 * Map a garment hex to human color names the suggest model can match against
 * prompts like "red outfit" (hex alone is easy to miss for dark burgundy).
 */
export function colorFamiliesFromHex(hex) {
  const rgb = parseHexRgb(hex);
  if (!rgb) return [];
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2 / 255;
  const saturation = max === 0 ? 0 : chroma / max;

  if (max < 38 && lightness < 0.16) return ["black"];
  if (min > 210 && saturation < 0.12) return ["white"];
  if (saturation < 0.12) {
    if (lightness < 0.28) return ["black", "charcoal", "gray"];
    if (lightness > 0.78) return ["white", "ivory", "cream"];
    return ["gray", "grey", "neutral"];
  }

  let hue = 0;
  if (chroma > 0) {
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const families = [];
  const push = (...names) => {
    for (const name of names) {
      if (!families.includes(name)) families.push(name);
    }
  };

  // Deep crimson/burgundy often sits near hue 330–360; treat dark warm tones as red first.
  if (hue < 18 || hue >= 330) {
    if (lightness < 0.42) push("red", "burgundy", "maroon", "wine", "dark red");
    else if (lightness > 0.62 && hue >= 330 && hue < 350) push("pink", "red");
    else push("red");
    if (lightness > 0.62 && hue < 18) push("pink", "light red");
  } else if (hue < 45) {
    push("orange", "rust");
    if (lightness < 0.4) push("brown", "terracotta");
    if (r > g && r > b + 25) push("red");
  } else if (hue < 70) {
    push("yellow", "gold");
    if (lightness < 0.45) push("mustard", "tan");
  } else if (hue < 160) {
    push("green");
    if (hue < 95) push("olive", "lime");
    if (lightness < 0.35) push("forest", "dark green");
  } else if (hue < 200) {
    push("teal", "cyan");
    if (lightness < 0.4) push("green");
  } else if (hue < 255) {
    push("blue");
    if (lightness < 0.35) push("navy", "dark blue");
    else if (lightness > 0.65) push("light blue", "sky");
  } else if (hue < 290) {
    push("purple", "violet");
    if (lightness < 0.4) push("plum");
  } else if (hue < 330) {
    push("pink", "magenta");
    if (r > b && lightness < 0.42) push("red", "burgundy", "maroon");
  }

  if (hue >= 15 && hue < 50 && lightness < 0.42 && saturation < 0.55) push("brown", "tan");
  if (hue >= 30 && hue < 70 && lightness > 0.55 && saturation < 0.45) push("beige", "cream", "khaki");

  return families;
}

function catalogColorFamilies(item) {
  const seen = new Set();
  const families = [];
  for (const hex of [item.color, item.secondaryColor, ...(Array.isArray(item.palette) ? item.palette.slice(0, 4) : [])]) {
    for (const name of colorFamiliesFromHex(hex)) {
      if (seen.has(name)) continue;
      seen.add(name);
      families.push(name);
    }
  }
  return families;
}

/** Score how well a garment's name/tags match words in the user prompt. */
function promptMatchScore(item, promptText = "") {
  const haystack = `${item.name || ""} ${catalogTags(item).join(" ")}`.toLowerCase();
  if (!haystack.trim()) return 0;
  return String(promptText || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

/**
 * After the model suggests an outfit, ensure every required part is present.
 * Picks the best unused catalog item for each missing part (name/tag match preferred).
 */
export function ensureRequiredParts(garments = [], requiredParts = [], pool = [], prompt = "") {
  const next = [...garments];
  const usedIds = new Set(next.map((item) => item.id));
  const present = new Set(next.map((item) => item.part));

  for (const part of requiredParts) {
    if (present.has(part)) continue;
    const candidates = pool.filter((item) => item.part === part && !usedIds.has(item.id));
    if (!candidates.length) continue;
    candidates.sort((a, b) => promptMatchScore(b, prompt) - promptMatchScore(a, prompt));
    const pick = candidates[0];
    next.push(pick);
    usedIds.add(pick.id);
    present.add(part);
  }

  return sortGarmentsByPart(next);
}

export function buildOutfitSuggestPrompt(catalog = [], userPrompt = "") {
  const wardrobe = catalog.map((item) => ({
    id: item.id,
    name: item.name || PART_LABEL[item.part] || "piece",
    part: item.part,
    category: PART_LABEL[item.part] || item.part || "piece",
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    palette: Array.isArray(item.palette) ? item.palette.slice(0, 4) : [],
    colorFamilies: catalogColorFamilies(item),
    tags: catalogTags(item),
  }));

  return `Pick one outfit from this wardrobe of owned garments.

Parts (authoritative — use part, not the item name):
- upperbody = Top
- wholebody_up = Jacket (fleeces, coats, blazers, overshirts, and any other outer layer all count)
- lowerbody = Bottom
- accessories_up = Accessory
- shoes = Shoes

Rules:
- Only use ids from the catalog. Every catalog item is owned; never invent or substitute ids.
- Include one upperbody and one lowerbody.
- At most one item per part except accessories_up.
- Jacket, shoes, and accessories are optional unless the request asks for them.
- If the request names a part explicitly or by a clear synonym (e.g. "jacket" or "coat" both mean wholebody_up), you must include a matching catalog item for that part in garmentIds, and list that part's id in requiredParts. Skip this only if the wardrobe truly has no item for that part.
- requiredParts should otherwise be empty — don't list a part just because you chose to include it for style reasons.
- When the user names a color (e.g. "red"), prefer garments whose colorFamilies include that color or a close synonym (burgundy/maroon/wine count as red; navy counts as blue). Do not ignore a matching piece just because the hex looks dark.
- Prefer color/tag harmony and the user's vibe (office, casual, etc.).

User request: ${userPrompt}

Catalog:
${JSON.stringify(wardrobe)}`;
}
