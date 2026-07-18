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
