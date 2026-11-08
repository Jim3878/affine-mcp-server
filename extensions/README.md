# Bundled extensions (NineDay)

Every `extensions/<name>/index.js` here is loaded at startup (see `src/extensions.ts`) and ships inside
the packed tgz. The folders are build output copied in from each extension's own repo and are not
committed here:

- `storyforge/` — from `E:\DevTool\StoryForge\cloud` (`npm run install-into-mcp` there).

`AFFINE_MCP_EXTENSIONS=<path>;<path>` loads extra extensions while developing one;
`AFFINE_MCP_EXTENSIONS_DISABLE=1` turns all of them off.

Host API an extension gets (`ExtensionHostContext`, `src/extensions.ts`): the host's `Y` and `z`, `openSession()`
(doc `load` / `push`, `timestamps`, `presence(docId)` for a doc's awareness room, `alive()`, `close`),
`currentUser()` and `registerTool`.
