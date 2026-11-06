// NineDay: extension loading. An extension is an ES module whose default export is
//   { name, version, register(ctx), cli?: { command, summary, run(args, ctx) } }
// It gets the host's own yjs and zod plus an authenticated doc session, so it can read and write
// workspace docs (including db$<ws>$... module docs) without bundling its own copies.
//
// Where extensions come from:
//   - every <package root>/extensions/<name>/index.js shipped inside this package (the tgz for partners);
//   - extra module paths in AFFINE_MCP_EXTENSIONS (separated by ";"), for developing an extension.
// AFFINE_MCP_EXTENSIONS_DISABLE=1 turns all of them off; AFFINE_DISABLED_EXTENSION_TOOLS (comma list)
// turns off single extension tools.

import { existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as Y from "yjs";
import { z } from "zod";

import type { GraphQLClient } from "./graphqlClient.js";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "./ws.js";
import { VERSION } from "./config.js";

export type ExtensionToolResult = { content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean };

export type ExtensionDocSession = {
  workspaceId: string;
  load(docId: string): Promise<Y.Doc>;
  push(docId: string, doc: Y.Doc, before: Uint8Array): Promise<void>;
  close(): void;
};

export type ExtensionHostContext = {
  Y: typeof Y;
  z: typeof z;
  hostVersion: string;
  defaultWorkspaceId?: string;
  openSession(workspaceId?: string): Promise<ExtensionDocSession>;
  registerTool(
    name: string,
    options: { title: string; description: string; inputSchema: Record<string, unknown> },
    handler: (args: any) => Promise<ExtensionToolResult>,
    flags: { readOnly: boolean },
  ): void;
};

export type AffineMcpExtension = {
  name: string;
  version: string;
  register(ctx: ExtensionHostContext): void;
  cli?: { command: string; summary: string; run(args: string[], ctx: ExtensionHostContext): Promise<void> };
};

function packageRoot() {
  // dist/extensions.js -> package root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function extensionEntryPoints(env: NodeJS.ProcessEnv): string[] {
  if (env.AFFINE_MCP_EXTENSIONS_DISABLE === "1") return [];
  const entries: string[] = [];
  const bundled = path.join(packageRoot(), "extensions");
  if (existsSync(bundled)) {
    for (const name of readdirSync(bundled).sort()) {
      const entry = path.join(bundled, name, "index.js");
      if (existsSync(entry)) entries.push(entry);
    }
  }
  for (const raw of (env.AFFINE_MCP_EXTENSIONS || "").split(";")) {
    const p = raw.trim();
    if (p) entries.push(path.resolve(p));
  }
  return [...new Set(entries)];
}

let cache: Promise<AffineMcpExtension[]> | undefined;

export function loadExtensions(env: NodeJS.ProcessEnv = process.env): Promise<AffineMcpExtension[]> {
  cache ??= (async () => {
    const out: AffineMcpExtension[] = [];
    const seen = new Set<string>();
    for (const entry of extensionEntryPoints(env)) {
      try {
        const mod = await import(pathToFileURL(entry).href);
        const ext = (mod.default ?? mod) as AffineMcpExtension;
        if (!ext || typeof ext.register !== "function" || typeof ext.name !== "string") {
          console.error(`[affine-mcp] Extension ${entry} has no { name, register } default export; skipped.`);
          continue;
        }
        if (seen.has(ext.name)) {
          console.error(`[affine-mcp] Extension "${ext.name}" loaded twice (${entry}); keeping the first.`);
          continue;
        }
        seen.add(ext.name);
        out.push(ext);
      } catch (error) {
        console.error(`[affine-mcp] Failed to load extension ${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  })();
  return cache;
}

export function createExtensionHost(options: {
  gql: GraphQLClient;
  defaultWorkspaceId?: string;
  registerTool?: ExtensionHostContext["registerTool"];
}): ExtensionHostContext {
  const { gql, defaultWorkspaceId } = options;
  return {
    Y,
    z,
    hostVersion: VERSION,
    defaultWorkspaceId,
    async openSession(workspaceId?: string) {
      const ws = workspaceId || defaultWorkspaceId;
      if (!ws) throw new Error("workspaceId is required (no default workspace configured).");
      const { endpoint, cookie, bearer } = await gql.getConnectionAuth();
      const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
      try {
        await joinWorkspace(socket, ws);
      } catch (error) {
        socket.disconnect();
        throw error;
      }
      return {
        workspaceId: ws,
        async load(docId: string) {
          const snapshot = await loadDoc(socket, ws, docId);
          const doc = new Y.Doc();
          if (snapshot.missing) Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
          return doc;
        },
        async push(docId: string, doc: Y.Doc, before: Uint8Array) {
          const update = Y.encodeStateAsUpdate(doc, before);
          const decoded = Y.decodeUpdate(update);
          if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) return;
          await pushDocUpdate(socket, ws, docId, Buffer.from(update).toString("base64"));
        },
        close() {
          socket.disconnect();
        },
      };
    },
    registerTool: options.registerTool ?? (() => {
      throw new Error("registerTool is only available in MCP server mode.");
    }),
  };
}

/** Which extension tools a tool profile exposes: full/authoring all, read_only only reads, core none. */
export function extensionToolAllowed(profile: string, readOnly: boolean, name: string, env: NodeJS.ProcessEnv = process.env) {
  const disabled = new Set((env.AFFINE_DISABLED_EXTENSION_TOOLS || "").split(",").map(s => s.trim()).filter(Boolean));
  if (disabled.has(name)) return false;
  if (profile === "core") return false;
  if (profile === "read_only") return readOnly;
  return true;
}
