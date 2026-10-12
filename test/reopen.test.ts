import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { leaveRequest, me, reopenRequest, workspace } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

async function loggedIn(opts: { settings?: unknown } = {}) {
  h = await startHarness({ now: "2026-09-24T09:00:00Z" });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  h.itfin
    .on("GET /api/v1/auth", { body: me })
    .on(`GET /api/v1/auth/workspaces/${new URL(h.itfin.url).host}`, { body: opts.settings ?? workspace })
    .on("GET /api/v1/requests/my", { body: [reopenRequest({ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" })] })
    .on("POST /api/v1/requests/open-reporting", { body: { Id: 55 } });
  return h;
}

const request = { from: "2026-09-14", to: "2026-09-18", reason: "Forgot to report last week" };
const filedBody = { RequestType: "OpenReporting", EmployeeId: 1001, DateFrom: "2026-09-14", DateTo: "2026-09-18", Comment: "Forgot to report last week" };

describe("itfin_get_workspace_settings", () => {
  it("returns the minimum comment length and whether reopen requests are enabled", async () => {
    await loggedIn();
    const res = await h.call("itfin_get_workspace_settings");
    expect(res.data).toEqual({ minCommentLength: 10, reopenRequestsEnabled: true });
  });
});

describe("itfin_list_reopen_requests", () => {
  it("lists the user's reopen requests with their status", async () => {
    await loggedIn();
    const res = await h.call("itfin_list_reopen_requests");
    expect(res.data.requests).toMatchObject([{ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" }]);
    expect(h.itfin.requests.at(-1)!.query).toMatchObject({ "filter[requestType]": "OpenReporting" });
  });
});

describe("itfin_request_reopen", () => {
  it("files the reopen request in one call", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_reopen", request);
    expect(res).toEqual({ isError: false, data: { requested: true, id: 55 } });
    expect(h.itfin.writes()).toMatchObject([{ method: "POST", path: "/api/v1/requests/open-reporting", body: filedBody }]);
  });
});

describe("itfin_request_reopen validation", () => {
  it("rejects a reason shorter than 10 characters before filing", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_reopen", { ...request, reason: "forgot" });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("refuses when the workspace has reopen requests disabled", async () => {
    await loggedIn({ settings: { Settings: { TrackingMinCommentLength: 10, OpenReportingApprovals: { Enabled: false } } } });
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

describe("itfin_cancel_reopen_request", () => {
  const myRequests = [
    reopenRequest({ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" }),
    reopenRequest({ id: 8, from: "2026-09-07", to: "2026-09-11", status: "Canceled" }),
    leaveRequest({ id: 5, type: "Vacation", from: "2026-10-01", to: "2026-10-02", status: "Pending" }),
  ];

  it("cancels one of the user's reopen requests", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", { body: myRequests }).on("DELETE /api/v1/requests/7", { status: 204 });
    const res = await h.call("itfin_cancel_reopen_request", { id: 7 });
    expect(res.data).toMatchObject({ cancelled: 7, request: { from: "2026-09-14", to: "2026-09-20" } });
    expect(h.itfin.writes()).toMatchObject([{ method: "DELETE", path: "/api/v1/requests/7" }]);
  });

  it("refuses ids that aren't the user's reopen requests, such as a leave request", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", { body: myRequests });
    expect((await h.call("itfin_cancel_reopen_request", { id: 5 })).data.error.code).toBe("NOT_FOUND");
    expect((await h.call("itfin_cancel_reopen_request", { id: 99 })).data.error.code).toBe("NOT_FOUND");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("refuses a request that is already cancelled", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", { body: myRequests });
    const res = await h.call("itfin_cancel_reopen_request", { id: 8 });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});
