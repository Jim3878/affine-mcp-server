#!/usr/bin/env node
// NineDay: download_blob / copy_blob against a fake AFFiNE (REST blob download + GraphQL setBlob).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { copyBlob, fetchBlob, registerBlobTools } from "../dist/tools/blobStorage.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png-body"),
]);
const BIG = Buffer.alloc(200, 7);

function parse(result) {
  return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text ?? "null");
}

class ToolRegistry {
  tools = new Map();
  registerTool(name, _definition, handler) {
    this.tools.set(name, handler);
  }
}

async function startFakeAffine() {
  const blobs = { "ws-a": { "img-key": PNG, "big-key": BIG, "plain-key": Buffer.from("hello") }, "ws-b": {} };
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url: req.url, headers: req.headers });

    const download = /^\/api\/workspaces\/([^/]+)\/blobs\/([^/]+)$/.exec(req.url);
    if (req.method === "GET" && download) {
      const blob = blobs[decodeURIComponent(download[1])]?.[decodeURIComponent(download[2])];
      if (!blob) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"message":"not found"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": blob.length });
      res.end(blob);
      return;
    }

    if (req.method === "POST" && req.url === "/graphql") {
      const raw = body.toString("latin1");
      const workspaceId = /\\"workspaceId\\":\\"([^\\]+)\\"|"workspaceId":"([^"]+)"/.exec(raw);
      const ws = workspaceId?.[1] ?? workspaceId?.[2];
      const filename = /filename="([^"]+)"/.exec(raw)?.[1];
      const boundary = /boundary=(.+)$/.exec(req.headers["content-type"])[1];
      const parts = raw.split(`--${boundary}`);
      const filePart = parts.find(part => part.includes('name="0"'));
      const payload = Buffer.from(filePart.slice(filePart.indexOf("\r\n\r\n") + 4, filePart.lastIndexOf("\r\n")), "latin1");
      blobs[ws] ??= {};
      blobs[ws][filename] = payload;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { setBlob: filename } }));
      return;
    }

    res.writeHead(500);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    blobs,
    requests,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

const affine = await startFakeAffine();
const tmp = mkdtempSync(path.join(os.tmpdir(), "affine-blob-copy-test-"));
process.env.AFFINE_BLOB_DOWNLOAD_DIR = path.join(tmp, "default");
try {
  const gql = {
    baseUrl: affine.baseUrl,
    async getConnectionAuth() {
      return {
        endpoint: `${affine.baseUrl}/graphql`,
        headers: { Cookie: "session=test-cookie", "Content-Type": "application/json" },
      };
    },
    async request() {
      throw new Error("Unexpected GraphQL request.");
    },
  };
  const config = { maxDecodedBytes: 100, timeoutMs: 2_000, maxResponseBytes: 1024 };
  const registry = new ToolRegistry();
  registerBlobTools(registry, gql, config);
  const downloadBlob = registry.tools.get("download_blob");
  const copyBlobTool = registry.tools.get("copy_blob");
  assert.equal(typeof downloadBlob, "function");
  assert.equal(typeof copyBlobTool, "function");

  // Reusable functions
  const fetched = await fetchBlob(gql, "ws-a", "img-key", config);
  assert.ok(fetched.data.equals(PNG));
  assert.equal(fetched.contentType, "image/png", "octet-stream is sniffed into image/png");
  assert.equal(affine.requests[0].headers.cookie, "session=test-cookie");
  assert.notEqual(affine.requests[0].headers["content-type"], "application/json", "GET must not carry the JSON content type");
  await assert.rejects(fetchBlob(gql, "ws-a", "missing", config), /was not found in workspace ws-a/);
  await assert.rejects(fetchBlob(gql, "ws-a", "big-key", config), /configured limit is 100 bytes/);
  await assert.rejects(copyBlob(gql, { sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-a", key: "img-key" }, config), /must be different/);

  // download_blob: default path, inline image, no silent overwrite
  const first = await downloadBlob({ workspaceId: "ws-a", key: "img-key" });
  const firstPayload = parse(first);
  assert.equal(firstPayload.ok, true);
  assert.equal(firstPayload.path, path.join(tmp, "default", "ws-a", "img-key.png"));
  assert.equal(firstPayload.size, PNG.length);
  assert.equal(firstPayload.inlineImage, true);
  assert.equal(first.content[1].type, "image");
  assert.equal(first.content[1].data, PNG.toString("base64"));
  assert.ok(readFileSync(firstPayload.path).equals(PNG));

  const again = await downloadBlob({ workspaceId: "ws-a", key: "img-key" });
  assert.equal(again.isError, true);
  assert.equal(parse(again).code, "blob_download_failed");
  assert.match(parse(again).error, /already exists/);
  assert.equal(parse(await downloadBlob({ workspaceId: "ws-a", key: "img-key", overwrite: true })).ok, true);

  const explicit = path.join(tmp, "out", "note.txt");
  const plain = await downloadBlob({ workspaceId: "ws-a", key: "plain-key", outputPath: explicit });
  assert.equal(parse(plain).path, explicit);
  assert.equal(parse(plain).inlineImage, false);
  assert.equal(plain.content.length, 1);
  assert.equal(readFileSync(explicit, "utf8"), "hello");

  const relative = await downloadBlob({ workspaceId: "ws-a", key: "plain-key", outputPath: "relative.txt" });
  assert.equal(relative.isError, true);
  assert.match(parse(relative).error, /absolute path/);

  const tooBig = await downloadBlob({ workspaceId: "ws-a", key: "big-key", outputPath: path.join(tmp, "big.bin") });
  assert.equal(tooBig.isError, true);
  assert.equal(existsSync(path.join(tmp, "big.bin")), false, "an oversized blob must not be written");

  const missing = await downloadBlob({ workspaceId: "ws-a", key: "missing" });
  assert.equal(missing.isError, true);
  assert.equal(parse(missing).kind, "blob.download");

  // copy_blob: key preserved, bytes identical, partial failure reported per key
  const copied = parse(await copyBlobTool({ sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-b", key: "img-key" }));
  assert.equal(copied.ok, true);
  assert.equal(copied.status, "copied");
  assert.deepEqual(copied.results, [
    { sourceKey: "img-key", targetKey: "img-key", size: PNG.length, contentType: "image/png", ok: true, keyChanged: false },
  ]);
  assert.ok(affine.blobs["ws-b"]["img-key"].equals(PNG), "target workspace received identical bytes");
  assert.ok(affine.blobs["ws-a"]["img-key"].equals(PNG), "source blob is untouched");

  const partialResult = await copyBlobTool({ sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-b", keys: ["plain-key", "missing", "plain-key"] });
  const partial = parse(partialResult);
  assert.notEqual(partialResult.isError, true);
  assert.equal(partial.ok, false);
  assert.equal(partial.status, "partial");
  assert.equal(partial.copied, 1);
  assert.equal(partial.failed, 1, "duplicate keys are copied once");
  assert.match(partial.results[1].error, /was not found/);
  assert.equal(affine.blobs["ws-b"]["plain-key"].toString(), "hello");

  const allFailed = await copyBlobTool({ sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-b", key: "missing" });
  assert.equal(allFailed.isError, true);
  assert.equal(parse(allFailed).code, "blob_copy_failed");
  assert.equal(parse(allFailed).status, "failed");

  for (const bad of [
    { sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-b" },
    { sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-a", key: "img-key" },
    { sourceWorkspaceId: "ws-a", targetWorkspaceId: "ws-b", keys: Array.from({ length: 51 }, (_, i) => `k${i}`) },
  ]) {
    const result = await copyBlobTool(bad);
    assert.equal(result.isError, true);
    assert.equal(parse(result).code, "blob_copy_failed");
  }

  console.log("Blob download/copy contract tests passed");
} finally {
  await affine.close();
  rmSync(tmp, { recursive: true, force: true });
}
