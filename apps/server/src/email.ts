import type { Env } from "./env";

export async function sendOtpEmail(env: Env, to: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[dev] OTP for ${to}: ${code}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      // The client reads the code from the subject line of the temp inbox.
      subject: `Your verification code: ${code}`,
      text: `Your verification code is ${code}. It expires in 10 minutes.`,
    }),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status} ${await res.text()}`);
}
