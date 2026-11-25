import * as Y from "yjs";

import { parseXywhString } from "./layout.js";

/** Doc cards that can sit directly on the edgeless canvas. */
export const EMBED_DOC_CARD_FLAVOURS = new Set<string>([
  "affine:embed-linked-doc",
  "affine:embed-synced-doc",
]);

export type EmbedDocCard = {
  id: string;
  flavour: string;
  xywh: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  index: string | null;
  pageId: string | null;
  style: string | null;
  scale: number | null;
  rotate: number | null;
  caption: string | null;
  /** NineDay fork: title font size (px) set from the canvas toolbar; null = default. */
  titleFontSize: number | null;
  /** Synced doc only: height before folding; non-null means the card is folded. */
  preFoldHeight: number | null;
  /** Custom title / description aliases; null = show the linked doc's own. */
  title: string | null;
  description: string | null;
  /** Reference params (mode, blockIds, ...) when the card points at part of a doc. */
  params?: Record<string, unknown>;
};

const stringOrNull = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value instanceof Y.Text) return value.toString();
  return null;
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const childIds = (value: unknown): string[] => {
  if (value instanceof Y.Array) return value.toArray().filter((v): v is string => typeof v === "string");
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
};

/** Serialize one embed-linked-doc / embed-synced-doc block. */
export function serializeEmbedDocCard(id: string, block: Y.Map<any>): EmbedDocCard {
  const xywhRaw = block.get("prop:xywh");
  const card: EmbedDocCard = {
    id,
    flavour: String(block.get("sys:flavour")),
    xywh: typeof xywhRaw === "string" ? xywhRaw : null,
    bounds: parseXywhString(xywhRaw),
    index: stringOrNull(block.get("prop:index")),
    pageId: stringOrNull(block.get("prop:pageId")),
    style: stringOrNull(block.get("prop:style")),
    scale: numberOrNull(block.get("prop:scale")),
    rotate: numberOrNull(block.get("prop:rotate")),
    caption: stringOrNull(block.get("prop:caption")),
    titleFontSize: numberOrNull(block.get("prop:titleFontSize")),
    preFoldHeight: numberOrNull(block.get("prop:preFoldHeight")),
    title: stringOrNull(block.get("prop:title")),
    description: stringOrNull(block.get("prop:description")),
  };
  const params = block.get("prop:params");
  const paramsJson = params instanceof Y.Map ? params.toJSON() : params;
  if (paramsJson && typeof paramsJson === "object") {
    card.params = paramsJson as Record<string, unknown>;
  }
  return card;
}

/**
 * Collect the doc cards placed on the canvas: embed-linked-doc / embed-synced-doc
 * blocks that are direct children of an `affine:surface` block. Cards inside a
 * note (page mode) have no canvas position and are skipped.
 */
export function collectCanvasEmbedDocCards(blocks: Y.Map<any>): EmbedDocCard[] {
  const cards: EmbedDocCard[] = [];
  const seen = new Set<string>();
  for (const [, surface] of blocks.entries()) {
    if (!(surface instanceof Y.Map)) continue;
    if (surface.get("sys:flavour") !== "affine:surface") continue;
    for (const childId of childIds(surface.get("sys:children"))) {
      if (seen.has(childId)) continue;
      const child = blocks.get(childId);
      if (!(child instanceof Y.Map)) continue;
      const flavour = child.get("sys:flavour");
      if (typeof flavour !== "string" || !EMBED_DOC_CARD_FLAVOURS.has(flavour)) continue;
      seen.add(childId);
      cards.push(serializeEmbedDocCard(childId, child));
    }
  }
  return cards;
}
