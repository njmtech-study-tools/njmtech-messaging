/**
 * Mail relay for the disposable inboxes (inbox+<tag>@njmtech.co.za).
 *
 * Cloudflare Email Routing hands each message for inbox@njmtech.co.za (and, with
 * subaddressing on, every inbox+<tag>@ variant) to this Worker. It posts the raw
 * message to the njm-messaging Worker, which files it in that inbox. This Worker has
 * to live in the Cloudflare account that owns njmtech.co.za; njm-messaging runs in
 * another account. Same pattern as the wealth-board brand-email relay.
 */

export interface Env {
  /** e.g. https://njm-messaging.njmcloud-243.workers.dev/api/inbound-email */
  INBOUND_URL: string;
  /** Same value as INBOUND_EMAIL_SECRET on njm-messaging. */
  INBOUND_SECRET: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();

    let status = 0;
    try {
      const response = await fetch(env.INBOUND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "message/rfc822",
          "X-Inbound-Secret": env.INBOUND_SECRET,
          "X-Envelope-To": message.to,
          "X-Envelope-From": message.from,
        },
        body: raw,
      });
      status = response.status;
      if (response.ok) return;
      console.error("inbound delivery failed", status, (await response.text()).slice(0, 200));
    } catch (err) {
      console.error("inbound delivery error", err);
    }

    if (status === 404 || status === 413) {
      message.setReject(status === 404 ? `No mailbox for ${message.to}` : "Message too large");
      return;
    }
    // Fails the delivery so the sending server retries later instead of losing the message.
    throw new Error(`Could not deliver message for ${message.to} (status ${status})`);
  },
} satisfies ExportedHandler<Env>;
