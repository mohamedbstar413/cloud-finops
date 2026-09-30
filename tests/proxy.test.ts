/** The request proxy: who is sent to sign-in, and which cross-site writes are refused. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

const req = (path: string, init: { method?: string; cookie?: boolean; origin?: string } = {}) =>
  new NextRequest(`http://app.test${path}`, {
    method: init.method ?? "GET",
    headers: { host: "app.test", ...(init.cookie ? { cookie: "cpo_session=abc" } : {}), ...(init.origin ? { origin: init.origin } : {}) },
  });

describe("request proxy", () => {
  it("sends visitors without a session to sign-in, remembering where they were going", () => {
    const r = proxy(req("/recommendations/held-back"));
    assert.equal(r.status, 307);
    assert.equal(r.headers.get("location"), "http://app.test/login?next=%2Frecommendations%2Fheld-back");
    assert.equal(proxy(req("/dashboard")).headers.get("location"), "http://app.test/login");
  });

  it("lets sign-in, sign-up, invitations and password resets through", () => {
    for (const p of ["/login", "/signup", "/forgot-password", "/reset-password/tok", "/invite/tok"]) assert.equal(proxy(req(p)).headers.get("x-middleware-next"), "1", p);
  });

  it("answers the API with 401 instead of a redirect, except its public endpoints", () => {
    assert.equal(proxy(req("/api/recommendations")).status, 401);
    assert.equal(proxy(req("/api/auth/login", { method: "POST" })).headers.get("x-middleware-next"), "1");
    assert.equal(proxy(req("/api/billing/webhook", { method: "POST" })).headers.get("x-middleware-next"), "1");
  });

  it("refuses writes from other sites, even with a session cookie", () => {
    assert.equal(proxy(req("/api/org/delete", { method: "POST", cookie: true, origin: "https://evil.example" })).status, 403);
    assert.equal(proxy(req("/api/org/delete", { method: "POST", cookie: true, origin: "http://app.test" })).headers.get("x-middleware-next"), "1");
    assert.equal(proxy(req("/api/recommendations", { cookie: true, origin: "https://evil.example" })).headers.get("x-middleware-next"), "1", "reads are not writes");
  });
});
