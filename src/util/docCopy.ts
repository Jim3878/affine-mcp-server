// NineDay: helpers for copy_docs_to_workspace.
//
// A doc is copied by pushing its whole Yjs state under a new doc id, so block ids, surface
// elements and database cells stay exactly as they were. Only the ids of *other docs* have to
// change, and those are rewritten in place before the push.
import * as Y from "yjs";
import fetch from "node-fetch";
import FormData from "form-data";
import type { GraphQLClient } from "../graphqlClient.js";

/** base64url(SHA-256) with optional padding: the shape of an AFFiNE blob key. */
const BLOB_KEY_PATTERN = /^[A-Za-z0-9_-]{43}=?$/;
const DEFAULT_BLOB_TIMEOUT_MS = 60_000;

export type DocReferenceScan = {
  /** Doc ids this doc points to through embed cards, inline references or relation columns. */
  linkedDocIds: Set<string>;
  /** Blob keys named by a `sourceId` property (images, attachments), whatever their shape. */
  sourceBlobKeys: Set<string>;
  /** Every other string that merely looks like a blob key (e.g. database file cells). */
  candidateBlobKeys: Set<string>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function noteString(key: string | null, value: string, scan: DocReferenceScan): void {
  if (!value) return;
  if (key === "prop:pageId" || key === "pageId" || key === "docId") {
    scan.linkedDocIds.add(value);
    return;
  }
  // setBlob stores a blob under the uploaded filename, so a sourceId is not always a hash.
  if (key === "prop:sourceId" || key === "sourceId") {
    scan.sourceBlobKeys.add(value);
    return;
  }
  if (BLOB_KEY_PATTERN.test(value)) scan.candidateBlobKeys.add(value);
}

function scanValue(key: string | null, value: unknown, scan: DocReferenceScan, seen: WeakSet<object>): void {
  if (typeof value === "string") {
    noteString(key, value, scan);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Y.Text) {
    for (const delta of value.toDelta() as Array<{ attributes?: unknown }>) {
      if (delta?.attributes) scanValue(null, delta.attributes, scan, seen);
    }
    return;
  }
  if (value instanceof Y.Map) {
    for (const [entryKey, entry] of value) scanValue(String(entryKey), entry, scan, seen);
    return;
  }
  if (value instanceof Y.Array) {
    value.forEach((entry: unknown) => scanValue(key, entry, scan, seen));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) scanValue(key, entry, scan, seen);
    return;
  }
  if (isPlainObject(value)) {
    for (const [entryKey, entry] of Object.entries(value)) scanValue(entryKey, entry, scan, seen);
  }
}

/** List the other docs and the blobs a doc refers to. Read-only. */
export function scanDocReferences(doc: Y.Doc): DocReferenceScan {
  const scan: DocReferenceScan = {
    linkedDocIds: new Set(),
    sourceBlobKeys: new Set(),
    candidateBlobKeys: new Set(),
  };
  scanValue(null, doc.getMap("blocks"), scan, new WeakSet<object>());
  for (const key of scan.sourceBlobKeys) scan.candidateBlobKeys.delete(key);
  return scan;
}

/** Deep-copy a JSON value, swapping any string that is exactly an old doc id. */
function remapPlain(value: unknown, idMap: ReadonlyMap<string, string>, counter: { count: number }): unknown {
  if (typeof value === "string") {
    const next = idMap.get(value);
    if (next === undefined) return value;
    counter.count += 1;
    return next;
  }
  if (Array.isArray(value)) return value.map(entry => remapPlain(entry, idMap, counter));
  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) next[key] = remapPlain(entry, idMap, counter);
    return next;
  }
  return value;
}

function rewriteText(text: Y.Text, idMap: ReadonlyMap<string, string>, counter: { count: number }): void {
  const formats: Array<{ index: number; length: number; attributes: Record<string, unknown> }> = [];
  let index = 0;
  for (const delta of text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 1;
    if (delta.attributes) {
      const changed: Record<string, unknown> = {};
      for (const [name, attribute] of Object.entries(delta.attributes)) {
        if (!attribute || typeof attribute !== "object") continue;
        const local = { count: 0 };
        const next = remapPlain(attribute, idMap, local);
        if (local.count > 0) {
          changed[name] = next;
          counter.count += local.count;
        }
      }
      if (Object.keys(changed).length > 0) formats.push({ index, length, attributes: changed });
    }
    index += length;
  }
  for (const format of formats) text.format(format.index, format.length, format.attributes);
}

function rewriteShared(value: unknown, idMap: ReadonlyMap<string, string>, counter: { count: number }, seen: WeakSet<object>): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (value instanceof Y.Text) {
    rewriteText(value, idMap, counter);
    return;
  }
  if (value instanceof Y.Map) {
    for (const [key, entry] of Array.from(value.entries())) {
      // A block's own id is never a doc reference.
      if (key === "sys:id") continue;
      if (entry instanceof Y.AbstractType) {
        rewriteShared(entry, idMap, counter, seen);
        continue;
      }
      const local = { count: 0 };
      const next = remapPlain(entry, idMap, local);
      if (local.count > 0) {
        value.set(String(key), next);
        counter.count += local.count;
      }
    }
    return;
  }
  if (value instanceof Y.Array) {
    const entries = value.toArray();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry instanceof Y.AbstractType) {
        rewriteShared(entry, idMap, counter, seen);
        continue;
      }
      const local = { count: 0 };
      const next = remapPlain(entry, idMap, local);
      if (local.count > 0) {
        value.delete(index, 1);
        value.insert(index, [next]);
        counter.count += local.count;
      }
    }
  }
}

/**
 * Point every reference to a doc in `idMap` at its new id, in place. Returns the number of
 * references rewritten. Doc ids are random nanoids, so an exact string match is a reference.
 */
export function rewriteDocReferences(doc: Y.Doc, idMap: ReadonlyMap<string, string>): number {
  const counter = { count: 0 };
  doc.transact(() => {
    rewriteShared(doc.getMap("blocks"), idMap, counter, new WeakSet<object>());
  });
  return counter.count;
}

/** Count blocks and edgeless surface elements, for comparing a copy with its source. */
export function summarizeDocContent(doc: Y.Doc): { blockCount: number; surfaceElementCount: number } {
  const blocks = doc.getMap("blocks") as Y.Map<unknown>;
  let surfaceElementCount = 0;
  for (const [, block] of blocks) {
    if (!(block instanceof Y.Map) || block.get("sys:flavour") !== "affine:surface") continue;
    const elements = block.get("prop:elements");
    const value = elements instanceof Y.Map ? elements.get("value") : (elements as any)?.value;
    if (value instanceof Y.Map) surfaceElementCount += value.size;
    else if (isPlainObject(value)) surfaceElementCount += Object.keys(value).length;
  }
  return { blockCount: blocks.size, surfaceElementCount };
}

export type BlobCopyOutcome =
  | { key: string; status: "copied"; size: number; contentType: string }
  | { key: string; status: "already_present" }
  | { key: string; status: "not_found" }
  | { key: string; status: "failed"; error: string };

function blobUrl(baseUrl: string, workspaceId: string, key: string): string {
  return `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(key)}`;
}

function authHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !["content-type", "content-length", "transfer-encoding", "accept"].includes(name.toLowerCase())),
  );
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Copy one blob between workspaces: skip it when the target already serves that key, otherwise
 * download it from the source and upload it with setBlob. Never throws; the outcome says what
 * happened. Blob keys are content hashes, so the key is the same on both sides.
 */
export async function copyBlobBetweenWorkspaces(
  gql: GraphQLClient,
  input: { sourceWorkspaceId: string; targetWorkspaceId: string; key: string; maxBytes: number; timeoutMs?: number },
): Promise<BlobCopyOutcome> {
  const { sourceWorkspaceId, targetWorkspaceId, key, maxBytes } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_BLOB_TIMEOUT_MS;
  try {
    const { endpoint, headers } = await gql.getConnectionAuth();
    const baseUrl = gql.baseUrl;
    const auth = authHeaders(headers);

    const present = await withTimeout(timeoutMs, async signal => {
      const response = await fetch(blobUrl(baseUrl, targetWorkspaceId, key), { method: "HEAD", headers: auth, signal: signal as any });
      return response.ok;
    }).catch(() => false);
    if (present) return { key, status: "already_present" };

    const downloaded = await withTimeout(timeoutMs, async signal => {
      const response = await fetch(blobUrl(baseUrl, sourceWorkspaceId, key), { headers: auth, signal: signal as any });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new Error(`blob is ${declared} bytes; the limit is ${maxBytes} bytes`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > maxBytes) throw new Error(`blob is ${data.length} bytes; the limit is ${maxBytes} bytes`);
      return { data, contentType: response.headers.get("content-type") || "application/octet-stream" };
    });
    if (!downloaded) return { key, status: "not_found" };

    const uploadedKey = await withTimeout(timeoutMs, async signal => {
      const form = new FormData();
      form.append("operations", JSON.stringify({
        query: "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
        variables: { workspaceId: targetWorkspaceId, blob: null },
      }));
      form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
      form.append("0", downloaded.data, { filename: key, contentType: downloaded.contentType });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...auth, ...form.getHeaders() },
        body: form as any,
        signal: signal as any,
      });
      const body = await response.text();
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { /* reported below */ }
      const message = parsed?.errors?.[0]?.message;
      if (!response.ok || message) throw new Error(`upload failed${response.ok ? "" : ` with HTTP ${response.status}`}${message ? `: ${message}` : ""}`);
      const result = parsed?.data?.setBlob;
      if (typeof result !== "string" || !result) throw new Error("upload returned no blob key");
      return result;
    });
    if (uploadedKey !== key) {
      return { key, status: "failed", error: `target stored the blob under a different key (${uploadedKey})` };
    }
    return { key, status: "copied", size: downloaded.data.length, contentType: downloaded.contentType };
  } catch (error: any) {
    return { key, status: "failed", error: error?.message ?? String(error) };
  }
}
