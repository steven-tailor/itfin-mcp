import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface StoredToken {
  token: string;
  /** Employee id of the logged-in user, cached after the first lookup. */
  employeeId?: number;
  /** Set when ITFin answered 401 to this token; it stays dead until the next login. */
  rejected?: boolean;
}

export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(token: string, extra?: Omit<StoredToken, "token">): Promise<void>;
  clear(): Promise<void>;
}

/** Keeps the ITFin token in the macOS Keychain as a generic password: service + workspace address. */
export class KeychainTokenStore implements TokenStore {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  async load(): Promise<StoredToken | undefined> {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"]);
      return JSON.parse(stdout.trim()) as StoredToken;
    } catch {
      return undefined;
    }
  }

  async save(token: string, extra: Omit<StoredToken, "token"> = {}): Promise<void> {
    const value = JSON.stringify({ token, ...extra });
    // Pass the secret on stdin (security -i), not argv, so it never shows up in the process list.
    const cmd = `add-generic-password -U -s ${quote(this.service)} -a ${quote(this.account)} -w ${quote(value)}\n`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Keychain write failed: ${stderr.trim() || code}`))));
      child.stdin.end(cmd);
    });
  }

  async clear(): Promise<void> {
    await run("security", ["delete-generic-password", "-s", this.service, "-a", this.account]).catch(() => undefined);
  }
}

/** A locked keyring makes secret-tool wait for an unlock prompt; give up instead of blocking every tool call. */
const SECRET_TOOL_TIMEOUT_MS = 15_000;

/** Keeps the ITFin token in the Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool`. */
export class SecretToolTokenStore implements TokenStore {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  async load(): Promise<StoredToken | undefined> {
    try {
      const { stdout } = await run("secret-tool", ["lookup", "service", this.service, "account", this.account], { timeout: SECRET_TOOL_TIMEOUT_MS });
      return JSON.parse(stdout.trim()) as StoredToken;
    } catch {
      return undefined;
    }
  }

  async save(token: string, extra: Omit<StoredToken, "token"> = {}): Promise<void> {
    const value = JSON.stringify({ token, ...extra });
    // secret-tool reads the secret from stdin, so it never shows up in the process list.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("secret-tool", ["store", "--label", `ITFin (${this.account})`, "service", this.service, "account", this.account], { stdio: ["pipe", "ignore", "pipe"], timeout: SECRET_TOOL_TIMEOUT_MS });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.stdin.on("error", reject); // secret-tool may exit before it reads the secret
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Keyring write failed: ${stderr.trim() || code}`))));
      child.stdin.end(value);
    });
  }

  async clear(): Promise<void> {
    await run("secret-tool", ["clear", "service", this.service, "account", this.account], { timeout: SECRET_TOOL_TIMEOUT_MS }).catch(() => undefined);
  }
}

/** The OS keychain: macOS Keychain, or the Secret Service on Linux. */
export function createTokenStore(service: string, account: string): TokenStore {
  return process.platform === "darwin" ? new KeychainTokenStore(service, account) : new SecretToolTokenStore(service, account);
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
