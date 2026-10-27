import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ReminderScheduler {
  /** Replaces any scheduled relogin reminder for the workspace with one at `at`. */
  schedule(at: Date, workspaceUrl: string): Promise<void>;
  /** Shows a desktop notification right away. */
  notify(title: string, message: string): Promise<void>;
}

/** One-shot relogin reminders as per-user launchd jobs that remove themselves after firing. */
export class LaunchdReminderScheduler implements ReminderScheduler {
  async schedule(at: Date, workspaceUrl: string): Promise<void> {
    const slug = createHash("sha1").update(workspaceUrl).digest("hex").slice(0, 10);
    const label = `com.itfin-mcp.relogin.${slug}`;
    const dir = join(homedir(), "Library", "LaunchAgents");
    const plist = join(dir, `${label}.plist`);
    const domain = `gui/${userInfo().uid}`;

    await run("launchctl", ["bootout", `${domain}/${label}`]).catch(() => undefined);
    rmSync(plist, { force: true });
    if (at.getTime() - Date.now() < 60_000) {
      await this.notify("ITFin", reminderText(workspaceUrl));
      return;
    }

    // launchd calendar intervals use the Mac's local time.
    const script = [
      notificationCommand("ITFin", reminderText(workspaceUrl)),
      `launchctl bootout ${domain}/${label}`,
      `rm -f '${plist}'`,
    ].join("; ");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>${escapeXml(script)}</string></array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key><integer>${at.getMonth() + 1}</integer>
    <key>Day</key><integer>${at.getDate()}</integer>
    <key>Hour</key><integer>${at.getHours()}</integer>
    <key>Minute</key><integer>${at.getMinutes()}</integer>
  </dict>
</dict>
</plist>
`,
    );
    await run("launchctl", ["bootstrap", domain, plist]);
  }

  async notify(title: string, message: string): Promise<void> {
    await run("/bin/sh", ["-c", notificationCommand(title, message)]).catch(() => undefined);
  }
}

/** One-shot relogin reminders as transient systemd user timers that remove themselves after firing. */
export class SystemdReminderScheduler implements ReminderScheduler {
  async schedule(at: Date, workspaceUrl: string): Promise<void> {
    const slug = createHash("sha1").update(workspaceUrl).digest("hex").slice(0, 10);
    const unit = `itfin-mcp-relogin-${slug}`;

    // Stop the old timer and its service, and clear failed state, so systemd-run can reuse the unit names.
    for (const name of [`${unit}.timer`, `${unit}.service`]) {
      await run("systemctl", ["--user", "stop", name]).catch(() => undefined);
      await run("systemctl", ["--user", "reset-failed", name]).catch(() => undefined);
    }
    if (at.getTime() - Date.now() < 60_000) {
      await this.notify("ITFin", reminderText(workspaceUrl));
      return;
    }

    // UTC, so the time does not depend on which TZ the server process and the systemd manager each see.
    const when = `${at.toISOString().slice(0, 16).replace("T", " ")}:00 UTC`;
    await run("systemd-run", ["--user", `--unit=${unit}`, `--on-calendar=${when}`, "--timer-property=AccuracySec=1s", "--collect", "--quiet", "notify-send", "ITFin", reminderText(workspaceUrl)]);
  }

  async notify(title: string, message: string): Promise<void> {
    await run("notify-send", [title, message]).catch(() => undefined);
  }
}

/** The OS reminder scheduler: launchd on macOS, systemd user timers on Linux. */
export function createReminderScheduler(): ReminderScheduler {
  return process.platform === "darwin" ? new LaunchdReminderScheduler() : new SystemdReminderScheduler();
}

function reminderText(workspaceUrl: string): string {
  return `Your ITFin token for ${new URL(workspaceUrl).host} expires soon. Ask Claude to log in to ITFin.`;
}

function notificationCommand(title: string, message: string): string {
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "");
  return `osascript -e 'display notification "${q(message)}" with title "${q(title)}"'`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
