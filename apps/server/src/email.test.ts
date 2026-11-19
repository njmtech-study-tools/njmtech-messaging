import { describe, expect, it } from "vitest";
import { buildOtpEmail } from "./email";

// Same rule as the client's extractOtp (apps/client/src/services/tempmail.ts): first 6-digit number.
const extract = (s: string) => s.match(/\b(\d{6})\b/)?.[1] ?? null;

describe("buildOtpEmail", () => {
  it("puts the code where the client looks for it (subject, then text intro)", () => {
    const m = buildOtpEmail("048213");
    expect(extract(m.subject)).toBe("048213");
    expect(extract(m.text)).toBe("048213");
    expect(m.html).toContain("048213");
  });
});
