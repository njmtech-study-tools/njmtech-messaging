import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { isInboxAddress, preview } from "./mailbox";

const env = { INBOX_DOMAIN: "njmtech.co.za", INBOX_LOCAL: "inbox" } as Env;

// Same shape the client builds: prefix + "e" + 10 base36 chars (apps/client/src/services/tempmail.ts).
const clientAddress = () => `inbox+e${Array.from({ length: 10 }, () => Math.floor(Math.random() * 36).toString(36)).join("")}@njmtech.co.za`;

describe("isInboxAddress", () => {
  it("accepts the addresses the client generates", () => {
    for (let i = 0; i < 50; i++) expect(isInboxAddress(env, clientAddress())).toBe(true);
  });

  it("rejects anything else on the domain, other domains and old mail.tm-style addresses", () => {
    for (const a of [
      "inbox@njmtech.co.za", // the bare routing address is not an inbox
      "admin@njmtech.co.za",
      "inbox+abc@njmtech.co.za", // tag too short
      "inbox+e12345678901@njmtech.co.zax",
      "inbox+e12345678901@evil.com",
      "e12345678901@dcpa.net",
      "inbox+e1234.5678@njmtech.co.za",
      "inbox+E12345678901@njmtech.co.za", // callers lowercase first
    ])
      expect(isInboxAddress(env, a), a).toBe(false);
  });
});

describe("preview", () => {
  it("collapses whitespace and keeps the code findable", () => {
    const p = preview("Your Ephemeral verification code is 048213.\n\n  It expires in 10 minutes.");
    expect(p).toBe("Your Ephemeral verification code is 048213. It expires in 10 minutes.");
    expect(p.match(/\b(\d{6})\b/)?.[1]).toBe("048213");
    expect(preview("x".repeat(500))).toHaveLength(200);
    expect(preview(undefined)).toBe("");
  });
});
