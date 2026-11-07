// NineDay: lean entry point for extension CLI commands (`affine-mcp-ext sf pull ...`), used by programs
// that call an extension many times (local StoryForge). Same as `affine-mcp <command>` for an extension
// command, but it loads only config, auth and the extensions (not every MCP tool module), and it reuses the
// email/password sign-in cookie between runs (kept next to the config file, which already holds the
// password) instead of signing in on every call.
import "./nodeRuntime.js";
import fs from "fs";
import path from "path";

import { loginWithPassword } from "./auth.js";
import { AuthSession } from "./authSession.js";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { createExtensionHost, loadExtensions } from "./extensions.js";
import { GraphQLClient } from "./graphqlClient.js";
import { resolveConfiguredAuth } from "./util/configuredAuth.js";

const SESSION_FILE = path.join(path.dirname(CONFIG_FILE), "ext-session.json");
type CachedSession = { baseUrl: string; email: string; cookieHeader: string; expiresAt?: number };

function readCached(baseUrl: string, email: string): string | null {
  try {
    const c = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) as CachedSession;
    if (c.baseUrl !== baseUrl || c.email !== email || !c.cookieHeader) return null;
    // Keep a margin: a cookie about to expire is not worth a failed call.
    if (c.expiresAt && c.expiresAt - Date.now() < 10 * 60_000) return null;
    return c.cookieHeader;
  } catch {
    return null;
  }
}

function writeCached(entry: CachedSession) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Caching is only an optimisation.
  }
}

function clearCached() {
  try { fs.rmSync(SESSION_FILE, { force: true }); } catch { /* ignore */ }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const ext = (await loadExtensions()).find(e => e.cli?.command === command);
  if (!ext?.cli) {
    console.error(`Unknown extension command: ${command ?? "(none)"}`);
    process.exit(2);
  }

  const config = loadConfig();
  const auth = resolveConfiguredAuth(config);
  const email = auth.apiToken || auth.cookie ? undefined : auth.email;
  const password = auth.apiToken || auth.cookie ? undefined : auth.password;
  const cached = email ? readCached(config.baseUrl, email) : null;

  const makeGql = (cookie: string | undefined) => {
    const session = new AuthSession({
      baseUrl: config.baseUrl,
      bearer: auth.apiToken,
      cookie: auth.cookie ?? cookie,
      email: cookie ? undefined : email,
      password: cookie ? undefined : password,
      headers: auth.headers,
      login: async (baseUrl, e, p, h) => {
        const result = await loginWithPassword(baseUrl, e, p, h);
        if (e) writeCached({ baseUrl, email: e, cookieHeader: result.cookieHeader, expiresAt: result.expiresAt });
        return result;
      },
    });
    return new GraphQLClient({
      endpoint: config.graphqlEndpoint,
      baseUrl: config.baseUrl,
      headers: { ...(config.headers || {}) },
      authProvider: () => session.ready(),
    });
  };

  const run = (cookie: string | undefined) =>
    ext.cli!.run(args.slice(1), createExtensionHost({ gql: makeGql(cookie), defaultWorkspaceId: config.defaultWorkspaceId }));

  try {
    await run(cached ?? undefined);
  } catch (error) {
    // A cached cookie the server no longer accepts: sign in again once.
    if (cached && /sign in|unauthori[sz]ed|401|403/i.test(error instanceof Error ? error.message : String(error))) {
      clearCached();
      await run(undefined);
    } else {
      throw error;
    }
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
