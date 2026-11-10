import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extractOtp } from "./services/tempmail";
import { db, sweepExpired } from "./db";
import { remaining } from "./util";

describe("tempmail", () => {
  it("extracts codes from subjects", () => {
    expect(extractOtp("Your verification code: 042917")).toBe("042917");
    expect(extractOtp("no code here 12345")).toBeNull();
  });
});

describe("disappearing messages", () => {
  it("sweeps only expired messages", async () => {
    const base = { peer: "p1", dir: "in" as const, kind: "text" as const, status: "received" as const, sentAt: 1 };
    await db.messages.bulkPut([
      { ...base, id: "a", text: "gone", expiresAt: 1000 },
      { ...base, id: "b", text: "stays", expiresAt: 5000 },
      { ...base, id: "c", text: "forever" },
    ]);
    expect(await sweepExpired(2000)).toBe(1);
    expect((await db.messages.toArray()).map((m) => m.id).sort()).toEqual(["b", "c"]);
  });
  it("formats countdowns", () => {
    expect(remaining(65_000, 0)).toBe("1m");
    expect(remaining(5_000, 0)).toBe("5s");
  });
});

import { timerLabel } from "./services/messenger";
describe("timerLabel", () => {
  it("formats all timer options", () => {
    expect([0, 30, 300, 3600, 86400, 604800].map(timerLabel)).toEqual(["off", "30 s", "5 min", "1 h", "1 d", "7 d"]);
  });
});

describe("sweep keeps chat previews honest", () => {
  it("replaces an expired last-message preview", async () => {
    await db.messages.clear();
    await db.contacts.put({ id: "p2", handle: "x", timer: 30, lastAt: 2, lastText: "secret", unread: 0 });
    const base = { peer: "p2", dir: "in" as const, kind: "text" as const, status: "received" as const };
    await db.messages.bulkPut([
      { ...base, id: "old", text: "older", sentAt: 1 },
      { ...base, id: "new", text: "secret", sentAt: 2, expiresAt: 10 },
    ]);
    await sweepExpired(20);
    expect((await db.contacts.get("p2"))!.lastText).toBe("older");
    await db.messages.delete("old");
    await db.messages.put({ ...base, id: "n2", text: "gone too", sentAt: 3, expiresAt: 10 });
    await sweepExpired(20);
    expect((await db.contacts.get("p2"))!.lastText).toBe("");
  });
});
