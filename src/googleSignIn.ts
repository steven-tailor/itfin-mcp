import { connectCdp, type CdpPage } from "./cdp.js";

export interface GoogleCredentials {
  email: string;
  /** Typed only if Google shows a password page. */
  password?: string;
}

interface Point {
  x: number;
  y: number;
}

/** What a page shows that matters for sign-in. Positions are viewport coordinates. */
export interface Probe {
  googleButton?: Point;
  accountChoice?: Point;
  hasPasswordInput: boolean;
  hasEmailInput: boolean;
}

export type Action = { step: string; click: Point } | { step: string; type: { selector: string; text: string } };

const EMAIL_INPUT = 'input#identifierId, input[name="identifier"], input[type="email"]';
const PASSWORD_INPUT = 'input[name="Passwd"], input[type="password"]';
const GOOGLE_BUTTON = 'iframe[src*="accounts.google.com/gsi/button"]';
const POLL_MS = 1000;
/** A step that did not change the page within this time is tried again. */
const RETRY_MS = 10_000;

/**
 * Picks the next step for one page. Pure, so it can be tested without a browser.
 * The password page also shows the account name, so the account chooser is checked last.
 */
export function decide(pageUrl: string, probe: Probe, creds: GoogleCredentials, workspaceUrl: string, googleWindowOpen: boolean): Action | undefined {
  const url = new URL(pageUrl);
  if (url.origin === new URL(workspaceUrl).origin) {
    if (!url.pathname.startsWith("/auth/login") || googleWindowOpen || !probe.googleButton) return undefined;
    return { step: "google-button", click: probe.googleButton };
  }
  if (url.hostname !== "accounts.google.com") return undefined;
  if (probe.hasPasswordInput) return creds.password ? { step: "password", type: { selector: PASSWORD_INPUT, text: creds.password } } : undefined;
  if (probe.hasEmailInput) return { step: "email", type: { selector: EMAIL_INPUT, text: creds.email } };
  if (probe.accountChoice) return { step: "account", click: probe.accountChoice };
  return undefined;
}

/** Runs inside the page: finds the visible elements `decide` needs. */
function probeExpression(email: string): string {
  return `(() => {
    const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const visible = (sel) => [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0);
    const want = ${JSON.stringify(email.toLowerCase())};
    const button = visible(${JSON.stringify(GOOGLE_BUTTON)});
    const account = [...document.querySelectorAll('[data-identifier], [data-email]')]
      .find((e) => (e.dataset.identifier ?? e.dataset.email ?? '').toLowerCase() === want && e.getBoundingClientRect().width > 0);
    return {
      googleButton: button ? centre(button) : undefined,
      accountChoice: account ? centre(account) : undefined,
      hasPasswordInput: !!visible(${JSON.stringify(PASSWORD_INPUT)}),
      hasEmailInput: !!visible(${JSON.stringify(EMAIL_INPUT)}),
    };
  })()`;
}

async function evaluate<T>(page: CdpPage, expression: string): Promise<T> {
  const res = (await page.send("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value: T } };
  return res.result.value;
}

async function perform(page: CdpPage, action: Action): Promise<void> {
  if ("click" in action) {
    const base = { ...action.click, button: "left", clickCount: 1 };
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { ...base, type });
    return;
  }
  const { selector, text } = action.type;
  const found = await evaluate<boolean>(page, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select?.(); return true; })()`);
  if (!found) return;
  await page.send("Input.insertText", { text });
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
  }
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Signs in to Google for the login browser on `port`, until `signal` aborts. Clicks the Google
 * button on the workspace login page, picks the account in Google's chooser, and types the login
 * and password only if Google asks for them. It never reads, logs or stores credentials beyond
 * typing them into the page; the caller decides where they come from.
 */
export async function driveGoogleSignIn(opts: { port: number; workspaceUrl: string; creds: GoogleCredentials; signal: AbortSignal }): Promise<void> {
  const lastAttempt = new Map<string, number>();
  while (!opts.signal.aborted) {
    try {
      const targets = ((await (await fetch(`http://127.0.0.1:${opts.port}/json/list`)).json()) as Target[]).filter((t) => t.type === "page" && t.url.startsWith("http"));
      const googleWindowOpen = targets.some((t) => new URL(t.url).hostname === "accounts.google.com");
      for (const target of targets) {
        const page = await connectCdp(target.webSocketDebuggerUrl);
        try {
          const probe = await evaluate<Probe>(page, probeExpression(opts.creds.email));
          const action = decide(target.url, probe, opts.creds, opts.workspaceUrl, googleWindowOpen);
          const key = `${target.id}:${action?.step}`;
          if (!action || Date.now() - (lastAttempt.get(key) ?? 0) < RETRY_MS) continue;
          lastAttempt.set(key, Date.now());
          await perform(page, action);
        } finally {
          page.close();
        }
      }
    } catch {
      // The browser is starting, closing or navigating; the next poll tries again.
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
