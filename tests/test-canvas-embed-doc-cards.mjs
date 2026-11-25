#!/usr/bin/env node
/** Offline: doc cards on the edgeless canvas are collected with position + link target.
 *  Covers surface-child filtering (cards inside a note are skipped), the NineDay
 *  titleFontSize prop, folded synced docs, and reference params. */
import assert from "node:assert/strict";

import * as Y from "yjs";

import { collectCanvasEmbedDocCards } from "../dist/edgeless/embedDocCards.js";
import { sortByFractionalIndex } from "../dist/edgeless/layout.js";

const doc = new Y.Doc();
const blocks = doc.getMap("blocks");

function addBlock(id, flavour, props = {}, children = []) {
  const block = new Y.Map();
  blocks.set(id, block);
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  const kids = new Y.Array();
  kids.push(children);
  block.set("sys:children", kids);
  for (const [key, value] of Object.entries(props)) block.set(`prop:${key}`, value);
  return block;
}

doc.transact(() => {
  addBlock("page", "affine:page", {}, ["surface", "note"]);
  addBlock("surface", "affine:surface", {}, ["synced", "linked", "frame", "folded"]);
  addBlock("note", "affine:note", { xywh: "[0,0,800,92]", index: "a0" }, ["inNote"]);
  addBlock("frame", "affine:frame", { xywh: "[0,0,10,10]", index: "a1" });
  addBlock("synced", "affine:embed-synced-doc", {
    xywh: "[120,-80.5,800,420]",
    index: "a3",
    pageId: "doc-synced",
    style: "syncedDoc",
    scale: 0.75,
    rotate: 0,
    caption: undefined,
    titleFontSize: 24,
    preFoldHeight: undefined,
  });
  addBlock("linked", "affine:embed-linked-doc", {
    xywh: "[1000,200,364,390]",
    index: "a2",
    pageId: "doc-linked",
    style: "vertical",
    rotate: 0,
    caption: "see also",
    title: "Alias",
  });
  const folded = addBlock("folded", "affine:embed-synced-doc", {
    xywh: "[0,900,800,48]",
    index: "a4",
    pageId: "doc-folded",
    style: "syncedDoc",
    preFoldHeight: 420,
  });
  const params = new Y.Map();
  params.set("mode", "edgeless");
  folded.set("prop:params", params);
  // A card in page mode: lives inside a note, has no canvas position.
  addBlock("inNote", "affine:embed-linked-doc", {
    xywh: "[0,0,0,0]",
    index: "a0",
    pageId: "doc-in-note",
    style: "horizontal",
  });
});

const cards = sortByFractionalIndex(collectCanvasEmbedDocCards(blocks));
assert.deepEqual(cards.map(card => card.id), ["linked", "synced", "folded"]);

const [linked, synced, folded] = cards;
assert.deepEqual(synced, {
  id: "synced",
  flavour: "affine:embed-synced-doc",
  xywh: "[120,-80.5,800,420]",
  bounds: { x: 120, y: -80.5, width: 800, height: 420 },
  index: "a3",
  pageId: "doc-synced",
  style: "syncedDoc",
  scale: 0.75,
  rotate: 0,
  caption: null,
  titleFontSize: 24,
  preFoldHeight: null,
  title: null,
  description: null,
});

assert.equal(linked.flavour, "affine:embed-linked-doc");
assert.equal(linked.pageId, "doc-linked");
assert.equal(linked.style, "vertical");
assert.equal(linked.scale, null);
assert.equal(linked.caption, "see also");
assert.equal(linked.title, "Alias");
assert.equal(linked.titleFontSize, null);
assert.deepEqual(linked.bounds, { x: 1000, y: 200, width: 364, height: 390 });
assert.equal("params" in linked, false);

assert.equal(folded.preFoldHeight, 420);
assert.deepEqual(folded.params, { mode: "edgeless" });

// No surface at all → nothing, no throw.
assert.deepEqual(collectCanvasEmbedDocCards(new Y.Doc().getMap("blocks")), []);

console.log("canvas embed doc cards: ok");
