/**
 * Unit tests for the GitHub webhook HMAC verifier. Pure Web Crypto.
 */
import { describe, it, expect } from "vitest";
import { verifyGithubSignature } from "../../src/lib/verify-webhook";

const secret = "test-secret";

async function signed(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

function bufferOf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

describe("verifyGithubSignature", () => {
  it("accepts a correct signature", async () => {
    const body = '{"event":"hello"}';
    const sig = await signed(body);
    expect(await verifyGithubSignature(secret, bufferOf(body), sig)).toBe(true);
  });

  it("rejects an incorrect signature", async () => {
    const body = '{"event":"hello"}';
    expect(await verifyGithubSignature(secret, bufferOf(body), "sha256=" + "0".repeat(64))).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyGithubSignature(secret, new ArrayBuffer(0), null)).toBe(false);
  });

  it("rejects a header without sha256= prefix", async () => {
    expect(await verifyGithubSignature(secret, new ArrayBuffer(0), "deadbeef")).toBe(false);
  });

  it("rejects length-mismatched signatures (timing-safe)", async () => {
    const body = '{"event":"hello"}';
    expect(await verifyGithubSignature(secret, bufferOf(body), "sha256=short")).toBe(false);
  });
});
