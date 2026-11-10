import type { Env } from "./env";
import { generateOtp, now, sha256Hex, timingSafeEqual } from "./util";

const OTP_TTL = 600; // seconds
const COOLDOWN = 60; // KV minimum TTL
const MAX_ATTEMPTS = 5;

interface OtpRecord {
  h: string;
  attempts: number;
  exp: number;
}

export async function issueOtp(env: Env, email: string): Promise<{ code: string } | { error: "cooldown" }> {
  if (await env.KV.get(`otpcd:${email}`)) return { error: "cooldown" };
  const code = generateOtp();
  const rec: OtpRecord = { h: await sha256Hex(`${email}:${code}`), attempts: 0, exp: now() + OTP_TTL * 1000 };
  await Promise.all([
    env.KV.put(`otp:${email}`, JSON.stringify(rec), { expirationTtl: OTP_TTL }),
    env.KV.put(`otpcd:${email}`, "1", { expirationTtl: COOLDOWN }),
  ]);
  return { code };
}

export async function checkOtp(env: Env, email: string, code: string): Promise<boolean> {
  const raw = await env.KV.get(`otp:${email}`);
  if (!raw) return false;
  const rec = JSON.parse(raw) as OtpRecord;
  if (rec.exp < now()) return false;
  if (timingSafeEqual(rec.h, await sha256Hex(`${email}:${code}`))) return true;
  rec.attempts++;
  if (rec.attempts >= MAX_ATTEMPTS) {
    await env.KV.delete(`otp:${email}`);
  } else {
    const ttl = Math.max(60, Math.ceil((rec.exp - now()) / 1000));
    await env.KV.put(`otp:${email}`, JSON.stringify(rec), { expirationTtl: ttl });
  }
  return false;
}

export async function consumeOtp(env: Env, email: string) {
  await env.KV.delete(`otp:${email}`);
}
