import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { bearerAuth } from "../src/auth.js";

function call(middleware: ReturnType<typeof bearerAuth>, authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const set = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ set, json } as unknown as Response);
  const res = { status } as unknown as Response;
  // status().set().json() chain
  (status as ReturnType<typeof vi.fn>).mockReturnValue({ set: set.mockReturnValue({ json }) });
  const next = vi.fn();
  middleware(req, res, next);
  return { next, status };
}

describe("bearerAuth", () => {
  const middleware = bearerAuth("s3cret-token");

  it("passes requests with the correct bearer token", () => {
    const { next, status } = call(middleware, "Bearer s3cret-token");
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects missing, malformed, and wrong tokens with 401", () => {
    for (const header of [undefined, "Bearer wrong", "Bearer ", "s3cret-token", "Basic s3cret-token"]) {
      const { next, status } = call(middleware, header);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(401);
    }
  });

  it("rejects tokens of different lengths without throwing (timing-safe hash path)", () => {
    const { next, status } = call(middleware, "Bearer x");
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});
