import type { Env } from "../env";
import { sendFcm } from "./fcm";
import { sendWebPush, type PushResult } from "./webpush";

export interface PushTarget {
  id: string;
  push_kind: string | null;
  push_data: string | null;
}

/** Sends a content-free "new message" wake-up to a device. Clears dead registrations. */
export async function pushDevice(env: Env, d: PushTarget): Promise<PushResult | "skipped"> {
  let result: PushResult | "skipped" = "skipped";
  try {
    if (d.push_kind === "webpush" && d.push_data && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      const sub = JSON.parse(d.push_data) as { endpoint: string };
      result = await sendWebPush(sub.endpoint, {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      });
    } else if (d.push_kind === "fcm" && d.push_data && env.FCM_SERVICE_ACCOUNT) {
      result = await sendFcm(env.FCM_SERVICE_ACCOUNT, d.push_data);
    }
  } catch (e) {
    console.warn("push error", d.id, e);
    result = "error";
  }
  if (result === "gone") {
    await env.DB.prepare("UPDATE devices SET push_kind = NULL, push_data = NULL WHERE id = ?").bind(d.id).run();
  }
  return result;
}
