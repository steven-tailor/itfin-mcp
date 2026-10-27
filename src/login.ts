import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { connectCdp, type CdpPage } from "./cdp.js";
import { driveGoogleSignIn, type GoogleCredentials } from "./googleSignIn.js";

const MAC_BROWSERS: Record<string, string> = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  arc: "/Applications/Arc.app/Contents/MacOS/Arc",
  chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
};

/** Linux browsers are commands on PATH; the first one found wins. */
const LINUX_BROWSERS: Record<string, string[]> = {
  chrome: ["google-chrome", "google-chrome-stable"],
  edge: ["microsoft-edge", "microsoft-edge-stable"],
  brave: ["brave-browser", "brave"],
  chromium: ["chromium", "chromium-browser"],
};

const IS_MAC = process.platform === "darwin";

function findOnPath(command: string): string | undefined {
  return (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command)).find((file) => existsSync(file));
}

function resolveBrowser(name: string): string {
  if (IS_MAC) return MAC_BROWSERS[name.toLowerCase()] ?? name;
  const commands = LINUX_BROWSERS[name.toLowerCase()];
  return (commands && commands.map(findOnPath).find(Boolean)) || name;
}

function defaultProfileDir(): string {
  if (IS_MAC) return join(homedir(), "Library", "Application Support", "itfin-mcp", "browser-profile");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "itfin-mcp", "browser-profile");
}

const TOKEN_COOKIE = "itfin-jwt";

export interface LoginSession {
  /** Resolves with the new ITFin token once the user has signed in. */
  token: Promise<string>;
}

/**
 * Opens the workspace in a Chromium-based browser with a dedicated profile and watches, over the
 * DevTools protocol, for the ITFin token cookie that ITFin sets after the user signs in.
 * The user signs in themselves, unless `google` is set: then the Google sign-in steps are driven
 * automatically (see googleSignIn.ts). The token still comes only from a real Google login.
 */
export async function startBrowserLogin(opts: { workspaceUrl: string; browser: string; profileDir?: string; maxWaitMs: number; google?: GoogleCredentials }): Promise<LoginSession> {
  const executable = resolveBrowser(opts.browser);
  if (!existsSync(executable)) throw new Error(`Browser not found: ${executable}. Set ITFIN_BROWSER to ${IS_MAC ? "chrome, edge, brave, arc, chromium" : "chrome, edge, brave, chromium"} or a path.`);

  const profileDir = opts.profileDir ?? defaultProfileDir();
  mkdirSync(profileDir, { recursive: true });
  const port = await freePort();
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdio: "ignore", detached: false },
  );

  const token = (async () => {
    const page = await connectToPage(port, opts.maxWaitMs);
    const autoSignIn = new AbortController();
    if (opts.google) void driveGoogleSignIn({ port, workspaceUrl: opts.workspaceUrl, creds: opts.google, signal: autoSignIn.signal });
    try {
      await page.send("Network.enable");
      // Drop a token left in the profile so the user really signs in and ITFin issues a fresh one.
      await page.send("Network.deleteCookies", { name: TOKEN_COOKIE, url: opts.workspaceUrl });
      await page.send("Page.navigate", { url: opts.workspaceUrl });
      const deadline = Date.now() + opts.maxWaitMs;
      while (Date.now() < deadline) {
        const { cookies } = (await page.send("Network.getCookies", { urls: [opts.workspaceUrl] })) as { cookies: { name: string; value: string }[] };
        const cookie = cookies.find((c) => c.name === TOKEN_COOKIE);
        if (cookie?.value) return decodeURIComponent(cookie.value).replace(/^Bearer\s+/i, "");
        await sleep(1000);
      }
      throw new Error("Timed out waiting for the ITFin login.");
    } finally {
      autoSignIn.abort();
      page.close();
      closeBrowser(child, port);
    }
  })();

  return { token };
}

async function connectToPage(port: number, maxWaitMs: number): Promise<CdpPage> {
  const deadline = Date.now() + Math.min(maxWaitMs, 30_000);
  let wsUrl: string | undefined;
  while (!wsUrl) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // Browser still starting.
    }
    if (!wsUrl) {
      if (Date.now() > deadline) throw new Error("The login browser did not start.");
      await sleep(250);
    }
  }
  return connectCdp(wsUrl);
}

function closeBrowser(child: ChildProcess, port: number): void {
  fetch(`http://127.0.0.1:${port}/json/version`)
    .then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
    .then(({ webSocketDebuggerUrl }) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })));
    })
    .catch(() => child.kill());
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
