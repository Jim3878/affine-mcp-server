#!/usr/bin/env node
// Unit test for the copy_docs_to_workspace helpers: a doc's Yjs state is replayed under a new
// id and only references to other docs are rewritten. Runs against dist/ and needs no server.
import * as Y from "yjs";
import {
  rewriteDocReferences,
  scanDocReferences,
  summarizeDocContent,
} from "../dist/util/docCopy.js";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const OLD_A = "docA_old_0000000000001";
const OLD_B = "docB_old_0000000000002";
const OUTSIDE = "docX_outside_000000003";
const NEW_A = "docA_new_0000000000001";
const NEW_B = "docB_new_0000000000002";
const BLOB_IMAGE = "LCa0a2j_xo_5m0U8HTBBNBNCLXBkg7-g-YpeiGJm564=";
const BLOB_CELL = "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg=";

function block(blocks, id, flavour, props = {}, children = []) {
  const map = new Y.Map();
  blocks.set(id, map);
  map.set("sys:id", id);
  map.set("sys:flavour", flavour);
  const kids = new Y.Array();
  map.set("sys:children", kids);
  kids.push(children);
  for (const [key, value] of Object.entries(props)) map.set(key, value);
  return map;
}

function buildSource() {
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");

  const text = new Y.Text();
  text.insert(0, "see ");
  text.insert(4, " ", { reference: { type: "LinkedPage", pageId: OLD_B } });
  text.insert(5, " and ");
  text.insert(10, " ", { reference: { type: "LinkedPage", pageId: OUTSIDE } });
  text.insert(11, " bold", { bold: true });

  const elements = new Y.Map();
  const elementValues = new Y.Map();
  const shape = new Y.Map();
  shape.set("type", "shape");
  shape.set("xywh", "[10,20,100,50]");
  const connector = new Y.Map();
  connector.set("type", "connector");
  connector.set("source", { id: "shape1" });
  connector.set("target", { id: "card1" });
  elementValues.set("shape1", shape);
  elementValues.set("conn1", connector);
  elements.set("type", "$blocksuite:internal:native$");
  elements.set("value", elementValues);

  const columns = new Y.Array();
  const cells = new Y.Map();
  const rowCells = new Y.Map();
  rowCells.set("colFile", { columnId: "colFile", value: [{ id: "f1", blobId: BLOB_CELL }] });
  cells.set("row1", rowCells);

  block(blocks, "page1", "affine:page", { "prop:title": new Y.Text("Source A") }, ["surface1", "note1"]);
  block(blocks, "surface1", "affine:surface", { "prop:elements": elements }, ["card1", "img1"]);
  block(blocks, "card1", "affine:embed-synced-doc", { "prop:pageId": OLD_B, "prop:xywh": "[300,40,400,200]" });
  block(blocks, "img1", "affine:image", { "prop:sourceId": BLOB_IMAGE });
  block(blocks, "note1", "affine:note", {}, ["p1", "link1", "self1", "db1"]);
  block(blocks, "p1", "affine:paragraph", { "prop:text": text });
  block(blocks, "link1", "affine:embed-linked-doc", { "prop:pageId": OUTSIDE });
  block(blocks, "self1", "affine:embed-linked-doc", { "prop:pageId": OLD_A });
  const db = block(blocks, "db1", "affine:database", { "prop:columns": columns, "prop:cells": cells }, ["row1"]);
  columns.push([
    { id: "colRel", type: "relation", name: "Rel", data: { target: { docId: OLD_B, blockId: "dbOther" } } },
    { id: "colFile", type: "attachment", name: "Files", data: {} },
  ]);
  block(blocks, "row1", "affine:paragraph", { "prop:text": new Y.Text("row") });
  block(blocks, "file1", "affine:attachment", { "prop:sourceId": "report.pdf", "prop:name": "report.pdf" });
  expect(db.get("sys:id") === "db1", "fixture sanity");
  return doc;
}

// Replay the source state into a fresh doc, exactly as the tool does across workspaces.
const source = buildSource();
const copy = new Y.Doc();
Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));

// 1. Scan reports linked docs and blobs.
const scan = scanDocReferences(copy);
expect(scan.linkedDocIds.has(OLD_B) && scan.linkedDocIds.has(OUTSIDE) && scan.linkedDocIds.has(OLD_A), "scan must list embed, inline and relation doc ids");
expect(scan.sourceBlobKeys.has(BLOB_IMAGE), "scan must list the image blob");
expect(scan.sourceBlobKeys.has("report.pdf"), "a sourceId that is a filename is still a blob key");
expect(scan.candidateBlobKeys.has(BLOB_CELL), "scan must list blob-looking strings in cells as candidates");
expect(!scan.candidateBlobKeys.has(BLOB_IMAGE), "a sourceId blob is not also a candidate");

// 2. Rewrite maps batch docs and leaves the rest alone.
const before = summarizeDocContent(copy);
const rewritten = rewriteDocReferences(copy, new Map([[OLD_A, NEW_A], [OLD_B, NEW_B]]));
expect(rewritten === 4, `expected 4 rewritten references, got ${rewritten}`);

const blocks = copy.getMap("blocks");
expect(blocks.get("card1").get("prop:pageId") === NEW_B, "embed-synced-doc card must point at the new doc");
expect(blocks.get("self1").get("prop:pageId") === NEW_A, "self link must point at the new self id");
expect(blocks.get("link1").get("prop:pageId") === OUTSIDE, "link outside the batch must stay unchanged");
expect(blocks.get("card1").get("prop:xywh") === "[300,40,400,200]", "card position must be preserved");

const delta = blocks.get("p1").get("prop:text").toDelta();
const refs = delta.filter(d => d.attributes?.reference).map(d => d.attributes.reference.pageId);
expect(JSON.stringify(refs) === JSON.stringify([NEW_B, OUTSIDE]), `inline references wrong: ${JSON.stringify(refs)}`);
expect(delta.map(d => d.insert).join("") === "see   and   bold", "inline text must be unchanged");
expect(delta.find(d => d.attributes?.reference).attributes.reference.type === "LinkedPage", "reference type must be kept");
expect(delta.at(-1).attributes?.bold === true, "other formatting must be kept");

const columns = blocks.get("db1").get("prop:columns").toArray();
expect(columns[0].data.target.docId === NEW_B && columns[0].data.target.blockId === "dbOther", "relation target doc id must be remapped, block id kept");
expect(columns[1].id === "colFile", "column order must be kept");

// 3. Structure and block ids are untouched.
const after = summarizeDocContent(copy);
expect(before.blockCount === 11 && after.blockCount === 11, "block count must be preserved");
expect(after.surfaceElementCount === 2, "surface elements must be preserved");
const elementValues = blocks.get("surface1").get("prop:elements").get("value");
expect(elementValues.get("conn1").get("target").id === "card1", "connector endpoints must be preserved");
expect(blocks.get("img1").get("prop:sourceId") === BLOB_IMAGE, "blob key must be unchanged");
for (const [id, value] of blocks) expect(value.get("sys:id") === id, `block ${id} lost its id`);

// 4. The source doc is never modified.
expect(source.getMap("blocks").get("card1").get("prop:pageId") === OLD_B, "source doc must stay untouched");

// 5. A second pass with the same map is a no-op.
expect(rewriteDocReferences(copy, new Map([[OLD_A, NEW_A], [OLD_B, NEW_B]])) === 0, "rewrite must be idempotent");

console.log("Doc copy rewrite tests passed");
