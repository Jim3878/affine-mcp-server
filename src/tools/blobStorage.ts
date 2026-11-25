import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text, toolError } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";
import { requireMatchingConfirmation } from "../util/inputSchemas.js";
import { readLimitedResponseBody } from "../util/httpResponse.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BlobContentEncoding = "utf8" | "base64";

export type BlobUploadConfig = {
  maxDecodedBytes: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

const DEFAULT_MAX_DECODED_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MULTIPART_MANAGED_HEADERS = new Set([
  "content-length",
  "content-type",
  "transfer-encoding",
]);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type BlobUploadGraphQLResponse = {
  data?: {
    setBlob?: unknown;
  };
  errors?: Array<{
    message?: unknown;
  }>;
};

class BlobUploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Blob upload timed out after ${timeoutMs}ms.`);
    this.name = "BlobUploadTimeoutError";
  }
}

function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  max?: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must not exceed ${max}. Received: ${raw}`);
  }
  return parsed;
}

export function loadBlobUploadConfig(env: NodeJS.ProcessEnv = process.env): BlobUploadConfig {
  return {
    maxDecodedBytes: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_MAX_BYTES",
      env.AFFINE_BLOB_UPLOAD_MAX_BYTES,
      DEFAULT_MAX_DECODED_BYTES,
    ),
    timeoutMs: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_TIMEOUT_MS",
      env.AFFINE_BLOB_UPLOAD_TIMEOUT_MS,
      DEFAULT_UPLOAD_TIMEOUT_MS,
      MAX_TIMER_DELAY_MS,
    ),
    maxResponseBytes: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES",
      env.AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
    ),
  };
}

function assertWithinDecodedLimit(size: number, maxDecodedBytes: number): void {
  if (size > maxDecodedBytes) {
    throw new Error(`Blob content is ${size} bytes after decoding; the configured limit is ${maxDecodedBytes} bytes.`);
  }
}

export function decodeBlobContent(
  content: string,
  encoding: BlobContentEncoding = "utf8",
  maxDecodedBytes: number = DEFAULT_MAX_DECODED_BYTES,
): Buffer {
  if (encoding === "utf8") {
    const size = Buffer.byteLength(content, "utf8");
    assertWithinDecodedLimit(size, maxDecodedBytes);
    return Buffer.from(content, "utf8");
  }

  const normalized = content.replace(/[ \t\r\n\f]/g, "");
  if (!CANONICAL_BASE64.test(normalized)) {
    throw new Error("Blob content is not valid canonical Base64.");
  }

  const paddingBytes = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedSize = (normalized.length / 4) * 3 - paddingBytes;
  assertWithinDecodedLimit(decodedSize, maxDecodedBytes);

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error("Blob content is not valid canonical Base64.");
  }
  return decoded;
}

function parseUploadResponse(body: string): BlobUploadGraphQLResponse {
  if (!body) {
    throw new Error("Blob upload returned an empty response.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Blob upload returned a response that was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Blob upload returned a JSON value that was not an object.");
  }
  return parsed as BlobUploadGraphQLResponse;
}

function firstGraphQLError(result: BlobUploadGraphQLResponse): string | null {
  const message = result?.errors?.[0]?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function validateMultipartMetadata(value: string, label: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain null bytes or line breaks.`);
  }
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new Error(`${label} must not exceed 255 UTF-8 bytes.`);
  }
  return value;
}

function buildMultipartHeaders(
  headers: Record<string, string>,
  formHeaders: Record<string, string>,
): Record<string, string> {
  const preserved = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !MULTIPART_MANAGED_HEADERS.has(name.toLowerCase()),
    ),
  );
  return {
    ...preserved,
    ...formHeaders,
  };
}

type BlobGql = Pick<GraphQLClient, "getConnectionAuth" | "baseUrl">;

export type BlobTransferOptions = Partial<BlobUploadConfig>;

export type FetchedBlob = {
  data: Buffer;
  contentType: string;
  size: number;
};

export type BlobCopyResult = {
  sourceKey: string;
  targetKey: string;
  size: number;
  contentType: string;
};

/** Images small enough to hand back inline next to the saved file. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_COPY_KEYS = 50;
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

function resolveTransferConfig(options: BlobTransferOptions | undefined): BlobUploadConfig {
  const defaults = loadBlobUploadConfig();
  return {
    maxDecodedBytes: options?.maxDecodedBytes ?? defaults.maxDecodedBytes,
    timeoutMs: options?.timeoutMs ?? defaults.timeoutMs,
    maxResponseBytes: options?.maxResponseBytes ?? defaults.maxResponseBytes,
  };
}

function requireBlobIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  if (/[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new Error(`${label} must not exceed 255 UTF-8 bytes.`);
  }
  return value;
}

/** AFFiNE often serves blobs as application/octet-stream; recognise the common image formats. */
function sniffImageType(data: Buffer): string | null {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString("latin1");
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (data.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function normalizeContentType(header: string | null, data: Buffer): string {
  const declared = (header ?? "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  return sniffImageType(data) ?? (declared || "application/octet-stream");
}

function destroyBody(response: any): void {
  if (typeof response?.body?.destroy === "function") response.body.destroy();
}

async function readLimitedBinaryBody(response: any, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    destroyBody(response);
    throw new Error(`Blob is ${declared} bytes; the configured limit is ${maxBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      destroyBody(response);
      throw new Error(`Blob exceeded the configured limit of ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Download one blob from workspace storage with the server's own session.
 * Throws on a missing blob, an oversized blob, or a timeout.
 */
export async function fetchBlob(
  gql: BlobGql,
  workspaceId: string,
  key: string,
  options?: BlobTransferOptions,
): Promise<FetchedBlob> {
  const config = resolveTransferConfig(options);
  requireBlobIdentifier(workspaceId, "workspaceId");
  requireBlobIdentifier(key, "key");
  const { headers } = await gql.getConnectionAuth();
  const requestHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !MULTIPART_MANAGED_HEADERS.has(name.toLowerCase())),
  );
  const url = `${gql.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", headers: requestHeaders, signal: controller.signal });
    if (!response.ok) {
      destroyBody(response);
      if (response.status === 404) {
        throw new Error(`Blob ${key} was not found in workspace ${workspaceId}.`);
      }
      throw new Error(`Blob download failed with HTTP ${response.status}.`);
    }
    const data = await readLimitedBinaryBody(response, config.maxDecodedBytes);
    return {
      data,
      contentType: normalizeContentType(response.headers.get("content-type"), data),
      size: data.length,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Blob download timed out after ${config.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Upload bytes into workspace storage through GraphQL setBlob and return the blob key. */
export async function putBlob(
  gql: Pick<GraphQLClient, "getConnectionAuth">,
  workspaceId: string,
  data: Buffer,
  meta: { filename?: string; contentType?: string } = {},
  options?: BlobTransferOptions,
): Promise<{ key: string; filename: string; contentType: string; size: number }> {
  const config = resolveTransferConfig(options);
  assertWithinDecodedLimit(data.length, config.maxDecodedBytes);
  const { endpoint, headers } = await gql.getConnectionAuth();
  const safeFilename = validateMultipartMetadata(meta.filename ?? `blob-${Date.now()}.bin`, "filename");
  const mime = validateMultipartMetadata(meta.contentType ?? "application/octet-stream", "contentType");

  const form = new FormData();
  form.append("operations", JSON.stringify({
    query: `mutation SetBlob($workspaceId: String!, $blob: Upload!) {
          setBlob(workspaceId: $workspaceId, blob: $blob)
        }`,
    variables: {
      workspaceId,
      blob: null
    }
  }));
  form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
  form.append("0", data, { filename: safeFilename, contentType: mime });

  const requestHeaders = buildMultipartHeaders(headers, form.getHeaders());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: form as any,
      signal: controller.signal,
    });
    const responseBody = await readLimitedResponseBody(
      response,
      config.maxResponseBytes,
      "Blob upload response",
    );
    let result: BlobUploadGraphQLResponse;
    try {
      result = parseUploadResponse(responseBody);
    } catch (error) {
      if (!response.ok) {
        throw new Error(`Blob upload failed with HTTP ${response.status}.`);
      }
      throw error;
    }

    const graphQLError = firstGraphQLError(result);
    if (!response.ok) {
      const detail = graphQLError ? `: ${graphQLError}` : "";
      throw new Error(`Blob upload failed with HTTP ${response.status}${detail}`);
    }
    if (graphQLError) {
      throw new Error(graphQLError);
    }
    const blobKey = result.data?.setBlob;
    if (typeof blobKey !== "string" || !blobKey.trim()) {
      throw new Error("Upload succeeded but no blob key was returned.");
    }
    return { key: blobKey, filename: safeFilename, contentType: mime, size: data.length };
  } catch (error: any) {
    if (controller.signal.aborted) {
      throw new BlobUploadTimeoutError(config.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Copy one blob between workspaces without the bytes leaving this process.
 * The source key is sent as the upload filename, which AFFiNE uses as the stored key,
 * so block sourceIds normally stay valid; callers should still use the returned targetKey.
 */
export async function copyBlob(
  gql: BlobGql,
  request: { sourceWorkspaceId: string; targetWorkspaceId: string; key: string },
  options?: BlobTransferOptions,
): Promise<BlobCopyResult> {
  const { sourceWorkspaceId, targetWorkspaceId, key } = request;
  requireBlobIdentifier(targetWorkspaceId, "targetWorkspaceId");
  if (sourceWorkspaceId === targetWorkspaceId) {
    throw new Error("sourceWorkspaceId and targetWorkspaceId must be different workspaces.");
  }
  const blob = await fetchBlob(gql, sourceWorkspaceId, key, options);
  const uploaded = await putBlob(gql, targetWorkspaceId, blob.data, { filename: key, contentType: blob.contentType }, options);
  return { sourceKey: key, targetKey: uploaded.key, size: blob.size, contentType: blob.contentType };
}

function safePathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return cleaned || "blob";
}

function defaultDownloadPath(workspaceId: string, key: string, contentType: string): string {
  const root = process.env.AFFINE_BLOB_DOWNLOAD_DIR?.trim() || path.join(os.tmpdir(), "affine-mcp-blobs");
  const name = safePathSegment(key);
  const extension = path.extname(name) ? "" : (EXTENSION_BY_TYPE[contentType] ?? ".bin");
  return path.join(root, safePathSegment(workspaceId), `${name}${extension}`);
}

export function registerBlobTools(
  server: McpServer,
  gql: GraphQLClient,
  uploadConfig: BlobUploadConfig = loadBlobUploadConfig(),
) {
  // UPLOAD BLOB/FILE
  const uploadBlobHandler = async ({
    workspaceId,
    content,
    encoding = "utf8",
    filename,
    contentType,
  }: {
    workspaceId: string;
    content: string;
    encoding?: BlobContentEncoding;
    filename?: string;
    contentType?: string;
  }) => {
    try {
      const payload = decodeBlobContent(content, encoding, uploadConfig.maxDecodedBytes);
      const uploaded = await putBlob(gql, workspaceId, payload, { filename, contentType }, uploadConfig);
      return text({
        id: uploaded.key,
        key: uploaded.key,
        workspaceId,
        filename: uploaded.filename,
        contentType: uploaded.contentType,
        encoding,
        size: payload.length,
        uploadedAt: new Date().toISOString()
      });
    } catch (error: any) {
      return toolError(error, {
        code: error instanceof BlobUploadTimeoutError
          ? "blob_upload_timeout"
          : "blob_upload_failed",
        retryable: false,
        data: {
          kind: "blob.upload",
          status: "failed",
          workspaceId,
          encoding,
        },
      });
    }
  };
  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob into AFFiNE workspace storage and return its blob key. This creates stored content but does not attach it to a document by itself.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        content: z.string().describe("Blob content encoded according to the encoding field."),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Content encoding. Defaults to utf8; use base64 explicitly for binary data."),
        filename: z.string().min(1).max(255).optional().describe("Optional filename stored with the upload. Defaults to a generated .bin name."),
        contentType: z.string().min(1).max(255).optional().describe("Optional MIME type. Defaults to application/octet-stream.")
      }
    },
    uploadBlobHandler as any
  );

  // DOWNLOAD BLOB (NineDay)
  const downloadBlobHandler = async ({ workspaceId, key, outputPath, overwrite = false }: { workspaceId: string; key: string; outputPath?: string; overwrite?: boolean }) => {
    try {
      if (outputPath !== undefined && !path.isAbsolute(outputPath)) {
        throw new Error("outputPath must be an absolute path.");
      }
      const blob = await fetchBlob(gql, workspaceId, key, uploadConfig);
      const target = path.resolve(outputPath ?? defaultDownloadPath(workspaceId, key, blob.contentType));
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.writeFile(target, blob.data, { flag: overwrite ? "w" : "wx" });
      } catch (error: any) {
        if (error?.code === "EEXIST") {
          throw new Error(`${target} already exists. Pass overwrite=true or choose another outputPath.`);
        }
        throw error;
      }
      const inline = INLINE_IMAGE_TYPES.has(blob.contentType) && blob.size <= MAX_INLINE_IMAGE_BYTES;
      const structuredContent = {
        kind: "blob.download",
        ok: true,
        workspaceId,
        key,
        path: target,
        size: blob.size,
        contentType: blob.contentType,
        inlineImage: inline,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(structuredContent) },
          ...(inline ? [{ type: "image" as const, data: blob.data.toString("base64"), mimeType: blob.contentType }] : []),
        ],
        structuredContent,
      };
    } catch (error: any) {
      return toolError(error, {
        code: "blob_download_failed",
        retryable: false,
        data: { kind: "blob.download", status: "failed", workspaceId, key },
      });
    }
  };
  server.registerTool(
    "download_blob",
    {
      title: "Download Blob",
      description: "Download a blob (image or attachment) from AFFiNE workspace storage to a local file on the machine running this server. Small images are also returned inline. Never overwrites an existing file unless overwrite=true.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        key: z.string().describe("Blob key: the sourceId of an image/attachment block, or the key returned by upload_blob."),
        outputPath: z.string().optional().describe("Absolute file path to write. Defaults to <AFFINE_BLOB_DOWNLOAD_DIR, or affine-mcp-blobs in the OS temp dir>/<workspaceId>/<key>.<ext>."),
        overwrite: z.boolean().optional().describe("Replace the file if it already exists. Defaults to false."),
      }
    },
    downloadBlobHandler as any
  );

  // COPY BLOB BETWEEN WORKSPACES (NineDay)
  const copyBlobHandler = async ({ sourceWorkspaceId, targetWorkspaceId, key, keys }: { sourceWorkspaceId: string; targetWorkspaceId: string; key?: string; keys?: string[] }) => {
    const failureData = { kind: "blob.copy", status: "failed", sourceWorkspaceId, targetWorkspaceId };
    try {
      const requested = [...new Set([...(key ? [key] : []), ...(keys ?? [])])];
      if (requested.length === 0) {
        throw new Error("Provide key or keys.");
      }
      if (requested.length > MAX_COPY_KEYS) {
        throw new Error(`copy_blob accepts at most ${MAX_COPY_KEYS} keys per call.`);
      }
      if (sourceWorkspaceId === targetWorkspaceId) {
        throw new Error("sourceWorkspaceId and targetWorkspaceId must be different workspaces.");
      }
      const results: Array<Record<string, unknown>> = [];
      for (const sourceKey of requested) {
        try {
          const copied = await copyBlob(gql, { sourceWorkspaceId, targetWorkspaceId, key: sourceKey }, uploadConfig);
          results.push({ ...copied, ok: true, keyChanged: copied.targetKey !== copied.sourceKey });
        } catch (error: any) {
          results.push({ sourceKey, ok: false, error: error?.message ?? String(error) });
        }
      }
      const copied = results.filter(result => result.ok).length;
      const failed = results.length - copied;
      if (copied === 0) {
        return toolError(
          results.length === 1 ? String(results[0].error) : `None of the ${results.length} blobs could be copied.`,
          { code: "blob_copy_failed", retryable: false, data: { ...failureData, copied, failed, results } },
        );
      }
      return text({
        kind: "blob.copy",
        ok: failed === 0,
        status: failed === 0 ? "copied" : "partial",
        sourceWorkspaceId,
        targetWorkspaceId,
        copied,
        failed,
        results,
      });
    } catch (error: any) {
      return toolError(error, { code: "blob_copy_failed", retryable: false, data: failureData });
    }
  };
  server.registerTool(
    "copy_blob",
    {
      title: "Copy Blob Between Workspaces",
      description: "Copy one or more blobs (images or attachments) from one AFFiNE workspace's storage to another's. The bytes are transferred by this server and never enter the conversation. Each result reports targetKey; use it as the sourceId in the target workspace (it normally equals the source key). The source blob is left untouched.",
      inputSchema: {
        sourceWorkspaceId: z.string().describe("Workspace id to copy the blob from."),
        targetWorkspaceId: z.string().describe("Workspace id to copy the blob into. Must differ from sourceWorkspaceId."),
        key: z.string().optional().describe("Blob key to copy."),
        keys: z.array(z.string()).max(MAX_COPY_KEYS).optional().describe(`Several blob keys to copy in one call (at most ${MAX_COPY_KEYS}).`),
      }
    },
    copyBlobHandler as any
  );

  // DELETE BLOB
  const deleteBlobHandler = async ({ workspaceId, key, permanently = false, confirmKey }: { workspaceId: string; key: string; permanently?: boolean; confirmKey?: string }) => {
    try {
      if (permanently) {
        requireMatchingConfirmation("permanent delete_blob", key, confirmKey);
      }
      const mutation = `
        mutation DeleteBlob($workspaceId: String!, $key: String!, $permanently: Boolean) {
          deleteBlob(workspaceId: $workspaceId, key: $key, permanently: $permanently)
        }
      `;
      
      const data = await gql.request<{ deleteBlob: boolean }>(mutation, {
        workspaceId,
        key,
        permanently
      });

      if (!data.deleteBlob) {
        return toolError("AFFiNE did not confirm blob deletion.", {
          code: "blob_delete_failed",
          retryable: false,
          data: {
            kind: "blob.delete",
            status: "not_applied",
            workspaceId,
            key,
            permanently,
            deleted: false,
          },
        });
      }

      return receipt("blob.delete", {
        status: "deleted",
        key,
        workspaceId,
        permanently,
        deleted: true,
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_delete_failed",
        retryable: false,
        data: {
          kind: "blob.delete",
          status: "failed",
          key,
          workspaceId,
          permanently,
          deleted: false,
        },
      });
    }
  };
  server.registerTool(
    "delete_blob",
    {
      title: "Delete Blob",
      description: "Delete a blob from AFFiNE workspace storage. Set permanently only when the blob should bypass recoverable deletion.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        key: z.string().describe("Blob key returned by upload_blob or AFFiNE document metadata."),
        permanently: z.boolean().optional().describe("If true, permanently delete the blob instead of marking it deleted."),
        confirmKey: z.string().optional().describe("Required when permanently=true and must exactly match key.")
      }
    },
    deleteBlobHandler as any
  );

  // RELEASE DELETED BLOBS
  const cleanupBlobsHandler = async ({ workspaceId, confirmWorkspaceId }: { workspaceId: string; confirmWorkspaceId?: string }) => {
    try {
      requireMatchingConfirmation("cleanup_blobs", workspaceId, confirmWorkspaceId);
      const mutation = `
        mutation ReleaseDeletedBlobs($workspaceId: String!) {
          releaseDeletedBlobs(workspaceId: $workspaceId)
        }
      `;
      
      const data = await gql.request<{ releaseDeletedBlobs: boolean }>(mutation, {
        workspaceId
      });

      if (!data.releaseDeletedBlobs) {
        return toolError("AFFiNE did not confirm deleted blob cleanup.", {
          code: "blob_cleanup_failed",
          retryable: false,
          data: {
            kind: "blob.cleanup",
            status: "not_applied",
            workspaceId,
            blobsReleased: false,
          },
        });
      }

      return receipt("blob.cleanup", {
        status: "completed",
        workspaceId,
        blobsReleased: true,
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_cleanup_failed",
        retryable: false,
        data: {
          kind: "blob.cleanup",
          status: "failed",
          workspaceId,
          blobsReleased: false,
        },
      });
    }
  };
  server.registerTool(
    "cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently release blobs that were already marked deleted in a workspace. This is destructive cleanup and should be used only after confirming deleted blobs are no longer needed.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id whose deleted blobs should be released."),
        confirmWorkspaceId: z.string().describe("Must exactly match workspaceId to confirm permanent blob cleanup.")
      }
    },
    cleanupBlobsHandler as any
  );
}
