import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { decide, type Probe } from "../src/googleSignIn.js";

const WORKSPACE = "https://acme.itfin.io";
const creds = { email: "me@acme.com", password: "pw" };
const none: Probe = { hasPasswordInput: false, hasEmailInput: false };
const at = { x: 10, y: 20 };

describe("decide", () => {
  it("clicks the Google button on the workspace login page", () => {
    const probe = { ...none, googleButton: at };
    expect(decide(`${WORKSPACE}/auth/login?back=%2F`, probe, creds, WORKSPACE, false)).toEqual({ step: "google-button", click: at });
  });

  it("waits while a Google window is already open", () => {
    expect(decide(`${WORKSPACE}/auth/login`, { ...none, googleButton: at }, creds, WORKSPACE, true)).toBeUndefined();
  });

  it("ignores other pages of the workspace", () => {
    expect(decide(`${WORKSPACE}/`, { ...none, googleButton: at }, creds, WORKSPACE, false)).toBeUndefined();
  });

  it("picks the account in the chooser", () => {
    expect(decide("https://accounts.google.com/v3/signin/accountchooser", { ...none, accountChoice: at }, creds, WORKSPACE, true)).toEqual({ step: "account", click: at });
  });

  it("types the login when Google asks for it", () => {
    expect(decide("https://accounts.google.com/v3/signin/identifier", { ...none, hasEmailInput: true }, creds, WORKSPACE, true)).toMatchObject({ step: "email", type: { text: "me@acme.com" } });
  });

  it("types the password, and does not mistake the password page for the chooser", () => {
    const probe = { ...none, hasPasswordInput: true, accountChoice: at };
    expect(decide("https://accounts.google.com/v3/signin/challenge/pwd", probe, creds, WORKSPACE, true)).toMatchObject({ step: "password", type: { text: "pw" } });
  });

  it("leaves a password page to the person when no password is set", () => {
    const probe = { ...none, hasPasswordInput: true };
    expect(decide("https://accounts.google.com/v3/signin/challenge/pwd", probe, { email: creds.email }, WORKSPACE, true)).toBeUndefined();
  });

  it("ignores pages of other sites", () => {
    expect(decide("https://example.com/", { ...none, hasEmailInput: true }, creds, WORKSPACE, false)).toBeUndefined();
  });
});

describe("Google credentials in config", () => {
  const base = { ITFIN_URL: WORKSPACE, ITFIN_CONFIG: "/nonexistent/config.json" };

  it("is off unless ITFIN_GOOGLE_EMAIL is set", () => {
    expect(loadConfig(base).google).toBeUndefined();
  });

  it("reads the login and password from the environment", () => {
    expect(loadConfig({ ...base, ITFIN_GOOGLE_EMAIL: " me@acme.com ", ITFIN_GOOGLE_PASSWORD: "pw" }).google).toEqual({ email: "me@acme.com", password: "pw" });
  });

  it("allows a login without a password", () => {
    expect(loadConfig({ ...base, ITFIN_GOOGLE_EMAIL: "me@acme.com" }).google).toEqual({ email: "me@acme.com", password: undefined });
  });

  it("rejects a password without a login", () => {
    expect(() => loadConfig({ ...base, ITFIN_GOOGLE_PASSWORD: "pw" })).toThrow("ITFIN_GOOGLE_EMAIL");
  });
});
