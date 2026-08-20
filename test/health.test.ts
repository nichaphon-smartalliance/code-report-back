import { describe, expect, test } from "bun:test";
import { app } from "../src/index.ts";

describe("GET /api/health", () => {
  test("returns 200 ok without a session", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
