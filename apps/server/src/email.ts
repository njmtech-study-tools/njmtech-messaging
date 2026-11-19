import type { Env } from "./env";

export type EmailResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "api_error"; message?: string };

/** Branded one-time-code email. The client reads the code from the subject (first 6-digit number). */
export function buildOtpEmail(code: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#0f172a;font-family:Helvetica,Arial,sans-serif;color:#e2e8f0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#1e293b;border-radius:8px;overflow:hidden">
<tr><td style="padding:20px 28px;font-size:20px;font-weight:bold;letter-spacing:.5px;border-bottom:1px solid #334155">Ephemeral</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 16px;font-size:14px;line-height:1.6">Your verification code:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:bold;letter-spacing:6px;font-family:Menlo,Consolas,monospace">${code}</p>
<p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8">It expires in 10 minutes. The app reads it automatically, so you don't need to type it in. If you didn't ask for it, ignore this email.</p>
</td></tr></table>
<p style="font-size:12px;color:#64748b;margin:16px 0 0">Ephemeral: private messaging, nothing stored on servers.</p>
</td></tr></table></body></html>`;

  const text = [
    `Your Ephemeral verification code is ${code}.`,
    "",
    "It expires in 10 minutes. The app reads it automatically, so you don't need to type it in.",
    "If you didn't ask for it, ignore this email.",
  ].join("\n");

  return { subject: `Your verification code: ${code}`, html, text };
}

/** Emails a one-time code via Resend. Never throws. */
export async function sendOtpEmail(env: Env, to: string, code: string): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    console.log(`[dev] OTP for ${to}: ${code}`);
    return { sent: false, reason: "not_configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        // Each code is sent once, even if the request is retried.
        "Idempotency-Key": `otp/${to}/${code}`,
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], ...buildOtpEmail(code) }),
    });
    if (!res.ok) return { sent: false, reason: "api_error", message: (await res.text()).slice(0, 200) };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: "api_error", message: err instanceof Error ? err.message : String(err) };
  }
}
