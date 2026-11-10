// NineDay: render_doc_screenshot. Opens a doc in a headless browser with the server's own AFFiNE
// session cookie and returns a PNG, so an agent can check layout it cannot infer from block data
// (text overflowing a shape, real note heights, whether an image renders).
//
// The browser comes from playwright-core, an optional dependency loaded on first use. It drives a
// browser already installed on the machine (Edge or Chrome) unless AFFINE_SCREENSHOT_BROWSER_PATH
// points at an executable, so installing this package downloads no browser.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphQLClient } from "../graphqlClient.js";
import { ToolFailure, toolError } from "../util/mcp.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NAVIGATION_TIMEOUT_MS = 45_000;
const MAX_PNG_BYTES = 6 * 1024 * 1024;

/** Chrome AFFiNE draws over the canvas; hidden so the screenshot shows only the document. */
const HIDE_CHROME_CSS = [
  "edgeless-toolbar-widget",
  "affine-edgeless-zoom-toolbar-widget",
  '[data-testid="open-in-app-card"]',
  '[data-testid="ai-island"]',
].join(", ") + " { display: none !important; }";

type Region = { x: number; y: number; width: number; height: number };

export type ScreenshotRequest = {
  baseUrl: string;
  cookieHeader: string;
  workspaceId: string;
  docId: string;
  mode: "edgeless" | "page";
  targetIds?: string[];
  region?: Region;
  padding: number;
  blockId?: string;
  scrollY?: number;
  width: number;
  height: number;
  scale: number;
  theme: "light" | "dark";
  waitMs: number;
};

export type ScreenshotResult = {
  png: Buffer;
  meta: Record<string, unknown>;
};

async function loadPlaywright(): Promise<any> {
  // A variable specifier keeps TypeScript from requiring the optional package at build time.
  const specifier = "playwright-core";
  try {
    return await import(specifier);
  } catch {
    throw new ToolFailure(
      "render_doc_screenshot needs the optional playwright-core package, which is not installed.",
      "screenshot_unavailable",
      "Reinstall affine-mcp-server without --omit=optional, or run `npm install playwright-core` in its install directory, then restart the MCP server.",
    );
  }
}

async function launchBrowser(playwright: any): Promise<any> {
  const executablePath = process.env.AFFINE_SCREENSHOT_BROWSER_PATH?.trim();
  const channels = (process.env.AFFINE_SCREENSHOT_BROWSER_CHANNEL || "msedge,chrome")
    .split(",").map(value => value.trim()).filter(Boolean);
  // The last attempt has no channel: a Chromium downloaded by `playwright install`, if any.
  const attempts: Record<string, unknown>[] = executablePath
    ? [{ executablePath }]
    : [...channels.map(channel => ({ channel })), {}];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await playwright.chromium.launch({ headless: true, ...attempt });
    } catch (error) {
      const label = (attempt.executablePath as string) || (attempt.channel as string) || "bundled chromium";
      failures.push(`${label}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
  }
  throw new ToolFailure(
    `No usable browser for render_doc_screenshot. Tried ${failures.join("; ")}`,
    "screenshot_unavailable",
    "Install Microsoft Edge or Google Chrome, or set AFFINE_SCREENSHOT_BROWSER_PATH to a Chromium-based browser executable, then retry.",
  );
}

function cookiesFor(baseUrl: string, cookieHeader: string) {
  return cookieHeader.split(";").map(pair => pair.trim()).filter(Boolean).map(pair => {
    const eq = pair.indexOf("=");
    return eq > 0 ? { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseUrl } : null;
  }).filter((cookie): cookie is { name: string; value: string; url: string } => cookie !== null);
}

/** Runs in the page: points the edgeless viewport at the requested bound and reports what it used. */
function frameEdgelessViewport(args: { targetIds: string[]; region: Region | null; padding: number }) {
  const root = document.querySelector("affine-edgeless-root") as any;
  const gfx = root?.gfx;
  const viewport = gfx?.viewport;
  if (!viewport) return { error: "The edgeless viewport is not available on this page." };

  const boundOf = (model: any): number[] | null => {
    const bound = model?.elementBound;
    if (bound && [bound.x, bound.y, bound.w, bound.h].every(Number.isFinite)) return [bound.x, bound.y, bound.w, bound.h];
    try {
      const parsed = JSON.parse(model?.xywh ?? "null");
      return Array.isArray(parsed) && parsed.length === 4 && parsed.every(Number.isFinite) ? parsed : null;
    } catch {
      return null;
    }
  };

  const boxes: number[][] = [];
  const missing: string[] = [];
  for (const id of args.targetIds) {
    const box = boundOf(gfx.getElementById(id));
    if (box) boxes.push(box); else missing.push(id);
  }
  if (args.region) boxes.push([args.region.x, args.region.y, args.region.width, args.region.height]);
  if (!boxes.length) {
    if (args.targetIds.length) return { error: `None of the targetIds are edgeless elements of this doc: ${missing.join(", ")}`, missing };
    const all = gfx.elementsBound;
    if (all && [all.x, all.y, all.w, all.h].every(Number.isFinite) && all.w > 0 && all.h > 0) boxes.push([all.x, all.y, all.w, all.h]);
  }
  if (!boxes.length) return { error: "The canvas has no elements to frame." };

  const minX = Math.min(...boxes.map(b => b[0])) - args.padding;
  const minY = Math.min(...boxes.map(b => b[1])) - args.padding;
  const maxX = Math.max(...boxes.map(b => b[0] + b[2])) + args.padding;
  const maxY = Math.max(...boxes.map(b => b[1] + b[3])) + args.padding;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const wanted = Math.min(viewport.width / width, viewport.height / height);
  const zoom = Math.min(viewport.ZOOM_MAX ?? 6, Math.max(viewport.ZOOM_MIN ?? 0.1, wanted));
  viewport.setViewport(zoom, [minX + width / 2, minY + height / 2]);
  return {
    bounds: { x: minX, y: minY, width, height },
    zoom: viewport.zoom,
    // The requested bound did not fit at the minimum zoom, so the edges are cut off.
    clipped: wanted < zoom,
    missing,
    // Size of the bound on screen, so the capture can be cropped to it instead of showing neighbours.
    fitted: { width: width * viewport.zoom, height: height * viewport.zoom },
  };
}

/** Runs in the page: scrolls page mode to a block or an offset and reports the scroll state. */
function scrollPageMode(args: { blockId: string | null; scrollY: number | null }) {
  const root = document.querySelector("affine-page-root") as HTMLElement | null;
  if (!root) return { error: "The page editor is not available on this page." };
  let scroller: HTMLElement | null = root;
  while (scroller) {
    const style = getComputedStyle(scroller);
    if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 4) break;
    scroller = scroller.parentElement;
  }
  const target = scroller ?? (document.scrollingElement as HTMLElement);
  let blockFound: boolean | null = null;
  let offset = 0;
  if (args.blockId) {
    // A surface-ref renders a preview that holds hidden copies of the doc's blocks under the same
    // ids, so take the copy that belongs to the page itself.
    const block = ([...document.querySelectorAll(`[data-block-id="${args.blockId}"]`)] as HTMLElement[])
      .find(element => !element.closest("affine-surface-ref")) ?? null;
    blockFound = !!block;
    if (block) {
      block.scrollIntoView({ block: "start" });
      offset = block.getBoundingClientRect().top - (scroller ?? root).getBoundingClientRect().top;
    }
  } else if (args.scrollY !== null) {
    target.scrollTop = args.scrollY;
  }
  const rect = (scroller ?? root).getBoundingClientRect();
  return {
    blockFound,
    // How far the block still is from the top of the view; lazily rendered content above it moves it.
    offset,
    scrollY: Math.round(target.scrollTop),
    scrollHeight: target.scrollHeight,
    viewHeight: target.clientHeight,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

export async function renderDocScreenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
  const playwright = await loadPlaywright();
  const browser = await launchBrowser(playwright);
  try {
    const context = await browser.newContext({
      viewport: { width: request.width, height: request.height },
      deviceScaleFactor: request.scale,
      colorScheme: request.theme,
    });
    await context.addCookies(cookiesFor(request.baseUrl, request.cookieHeader));
    const page = await context.newPage();
    const rootSelector = request.mode === "edgeless" ? "affine-edgeless-root" : "affine-page-root";
    await page.goto(
      `${request.baseUrl}/workspace/${request.workspaceId}/${request.docId}?mode=${request.mode}`,
      { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS },
    );
    try {
      await page.waitForSelector(rootSelector, { timeout: NAVIGATION_TIMEOUT_MS });
    } catch {
      // innerText, not textContent: the latter also returns the text of inline scripts.
      const body = ((await page.innerText("body").catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 160);
      throw new ToolFailure(
        `The doc did not open in ${request.mode} mode. Page says: ${body || "(empty)"}`,
        /sign in|log in|do not have access/i.test(body) ? "access_denied" : "screenshot_failed",
      );
    }
    await page.addStyleTag({ content: HIDE_CHROME_CSS });

    // AFFiNE's sidebar and header take part of the window. Grow the window so the editor itself
    // ends up with the requested size.
    const measure = () => page.evaluate((selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, rootSelector);
    let rootRect = await measure();
    if (request.mode === "edgeless") {
      await page.setViewportSize({
        width: Math.round(request.width + (request.width - rootRect.width)),
        height: Math.round(request.height + (request.height - rootRect.height)),
      });
      await page.waitForTimeout(400);
      rootRect = await measure();
    }

    let details: Record<string, any>;
    let clip = rootRect;
    if (request.mode === "edgeless") {
      details = await page.evaluate(frameEdgelessViewport, {
        targetIds: request.targetIds ?? [],
        region: request.region ?? null,
        padding: request.padding,
      });
    } else {
      details = await page.evaluate(scrollPageMode, { blockId: request.blockId ?? null, scrollY: request.scrollY ?? null });
      if (details.clip) clip = details.clip;
    }
    if (details.error) throw new ToolFailure(details.error, "screenshot_target_not_found");
    if (details.fitted) {
      // The view is centred on the bound; crop to it so a wide diagram does not drag in what sits above and below.
      const width = Math.min(clip.width, details.fitted.width);
      const height = Math.min(clip.height, details.fitted.height);
      clip = { x: clip.x + (clip.width - width) / 2, y: clip.y + (clip.height - height) / 2, width, height };
      delete details.fitted;
    }

    // AFFiNE keeps a sync socket open, so the network rarely goes fully idle; this only gives images a moment.
    await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => undefined);
    await page.waitForTimeout(request.waitMs);
    if (request.mode === "page" && (request.blockId || request.scrollY !== undefined)) {
      // Images and embeds above the target load lazily and change height, which moves the target
      // after the first scroll. Scroll again until it stays put.
      for (let attempt = 0; attempt < 6; attempt++) {
        const settled = await page.evaluate(scrollPageMode, { blockId: request.blockId ?? null, scrollY: request.scrollY ?? null });
        if (settled.error) break;
        if (settled.clip) clip = settled.clip;
        const moved = Math.abs(settled.offset ?? 0) > 4 || settled.scrollHeight !== details.scrollHeight;
        details = settled;
        await page.waitForTimeout(500);
        if (!moved) break;
      }
    }
    delete details.offset;

    const windowSize = page.viewportSize() ?? { width: request.width, height: request.height };
    const x = Math.max(0, Math.floor(clip.x));
    const y = Math.max(0, Math.floor(clip.y));
    const png: Buffer = await page.screenshot({
      type: "png",
      clip: {
        x,
        y,
        width: Math.max(1, Math.min(Math.ceil(clip.width), windowSize.width - x)),
        height: Math.max(1, Math.min(Math.ceil(clip.height), windowSize.height - y)),
      },
    });
    delete details.clip;
    return { png, meta: details };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function registerScreenshotTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const handler = async (args: {
    workspaceId?: string;
    docId: string;
    mode?: "edgeless" | "page";
    targetIds?: string[];
    region?: Region;
    padding?: number;
    blockId?: string;
    scrollY?: number;
    width?: number;
    height?: number;
    scale?: number;
    theme?: "light" | "dark";
    waitMs?: number;
  }) => {
    const workspaceId = args.workspaceId || defaults.workspaceId;
    const mode = args.mode ?? "edgeless";
    const failed = (error: unknown, code?: string) => toolError(error, {
      ...(code ? { code } : {}),
      data: { kind: "doc.screenshot", status: "failed", workspaceId: workspaceId ?? null, docId: args.docId, mode },
    });
    try {
      if (!workspaceId) throw new Error("workspaceId is required when no default workspace is configured.");
      for (const [label, value] of [["workspaceId", workspaceId], ["docId", args.docId], ["blockId", args.blockId], ...(args.targetIds ?? []).map(id => ["targetIds", id])] as [string, string | undefined][]) {
        if (value !== undefined && !ID_PATTERN.test(value)) {
          return failed(`${label} contains characters that are not valid in an AFFiNE id.`, "invalid_arguments");
        }
      }
      if (mode === "page" && (args.targetIds?.length || args.region)) {
        return failed("targetIds and region apply to edgeless mode. In page mode use blockId or scrollY.", "invalid_arguments");
      }
      if (mode === "edgeless" && (args.blockId || args.scrollY !== undefined)) {
        return failed("blockId and scrollY apply to page mode. In edgeless mode use targetIds or region.", "invalid_arguments");
      }

      const auth = await gql.getConnectionAuth();
      if (!auth.cookie) {
        return failed(
          new ToolFailure(
            "render_doc_screenshot needs a cookie session. This server is signed in with an API token, which the AFFiNE web app does not accept.",
            "screenshot_unavailable",
            "Sign this server in with `affine-mcp login` (email and password) or AFFINE_COOKIE, then restart it.",
          ),
        );
      }

      const { png, meta } = await renderDocScreenshot({
        baseUrl: gql.baseUrl,
        cookieHeader: auth.cookie,
        workspaceId,
        docId: args.docId,
        mode,
        targetIds: args.targetIds,
        region: args.region,
        padding: args.padding ?? 40,
        blockId: args.blockId,
        scrollY: args.scrollY,
        width: args.width ?? 1600,
        height: args.height ?? 1000,
        scale: args.scale ?? 1,
        theme: args.theme ?? "light",
        waitMs: args.waitMs ?? 1500,
      });
      if (png.byteLength > MAX_PNG_BYTES) {
        return failed(`The screenshot is ${png.byteLength} bytes, over the ${MAX_PNG_BYTES} byte limit. Use a smaller width/height or scale.`, "screenshot_too_large");
      }
      const structuredContent = {
        kind: "doc.screenshot",
        ok: true,
        workspaceId,
        docId: args.docId,
        mode,
        mimeType: "image/png",
        bytes: png.byteLength,
        ...meta,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(structuredContent) },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
        structuredContent,
      };
    } catch (error) {
      return failed(error);
    }
  };

  server.registerTool(
    "render_doc_screenshot",
    {
      title: "Render Doc Screenshot",
      description:
        "Render a document in a headless browser and return a PNG image, for checking what block data cannot show: " +
        "text overflowing a shape, connector label placement, real note heights, whether an image renders. " +
        "Edgeless mode frames targetIds (frame/note/surface element ids) or a canvas region, or the whole canvas when " +
        "neither is given; a large canvas is unreadable in one image, so frame one diagram or note at a time. " +
        "Page mode shows one window of the page; use blockId or scrollY to move, and the returned scrollHeight/viewHeight " +
        "to page through. Needs a browser on the server machine and a cookie session. Read-only; takes several seconds.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: z.string().min(1).describe("Document ID"),
        mode: z.enum(["edgeless", "page"]).default("edgeless").describe("Which editor mode to render (default edgeless)."),
        targetIds: z.array(z.string().min(1)).max(50).optional().describe(
          "Edgeless only. Ids of frames, notes or surface elements to frame; the view fits their union. Ids that are not on the canvas come back under 'missing'.",
        ),
        region: z.object({
          x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
        }).optional().describe("Edgeless only. Canvas-coordinate rectangle to frame. Combined with targetIds when both are given."),
        padding: z.number().min(0).max(2000).default(40).describe("Edgeless only. Canvas units added around the framed bound (default 40)."),
        blockId: z.string().min(1).optional().describe("Page mode only. Scroll this block to the top of the view."),
        scrollY: z.number().min(0).optional().describe("Page mode only. Scroll offset in pixels. Ignored when blockId is given."),
        width: z.number().int().min(400).max(2400).default(1600).describe("Width of the rendered editor area in CSS pixels (default 1600)."),
        height: z.number().int().min(300).max(2000).default(1000).describe("Height of the rendered editor area in CSS pixels (default 1000)."),
        scale: z.number().min(0.5).max(2).default(1).describe("Device pixel ratio of the image (default 1). 2 doubles the pixel size for small text."),
        theme: z.enum(["light", "dark"]).default("light").describe("Color scheme to render (default light)."),
        waitMs: z.number().int().min(0).max(10000).default(1500).describe("Extra settle time before capture in milliseconds (default 1500)."),
      },
    },
    handler as any,
  );
}
