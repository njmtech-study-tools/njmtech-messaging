/**
 * FileBlob — one Durable Object per encrypted attachment.
 *
 * Holds the ciphertext of a single file (the key travels end-to-end inside the
 * message, never here) until every target device has downloaded it. Replaces R2,
 * which needs a paid plan: SQLite-backed Durable Objects are on the Workers free plan.
 *
 * SQLite-backed DO values are capped at 2 MB, so the blob is stored in 1 MiB chunks.
 * An alarm wipes the object 24 hours after upload whether or not it was collected.
 */
import { DurableObject } from "cloudflare:workers";
import { MAX_FILE_BYTES } from "@njm/shared/protocol";
import type { Env } from "./env";

const CHUNK = 1024 * 1024;
export const FILE_MAX_AGE_MS = 24 * 3600 * 1000;
/** Ciphertext = plaintext + a small AEAD tag. */
const MAX_CT_BYTES = MAX_FILE_BYTES + 64;

interface Meta {
  size: number;
  chunks: number;
}

export class FileBlob extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "PUT") return this.put(req);
    if (req.method === "GET") return this.get();
    return new Response("method not allowed", { status: 405 });
  }

  private async put(req: Request): Promise<Response> {
    if (await this.ctx.storage.get("meta")) return new Response("exists", { status: 409 });
    const body = req.body;
    if (!body) return new Response("empty", { status: 400 });

    // Read the stream into fixed-size chunks without ever holding more than one extra chunk.
    const reader = body.getReader();
    let buf = new Uint8Array(CHUNK);
    let fill = 0;
    let size = 0;
    let chunks = 0;
    const flush = async () => {
      if (!fill) return;
      await this.ctx.storage.put(`c:${chunks++}`, buf.slice(0, fill));
      fill = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CT_BYTES) {
        await reader.cancel();
        await this.ctx.storage.deleteAll();
        return new Response("too large", { status: 413 });
      }
      let off = 0;
      while (off < value.byteLength) {
        const n = Math.min(CHUNK - fill, value.byteLength - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === CHUNK) await flush();
      }
    }
    await flush();
    if (!size) return new Response("empty", { status: 400 });
    // Written last: a blob without meta is an incomplete upload and reads as missing.
    await this.ctx.storage.put("meta", { size, chunks } satisfies Meta);
    await this.ctx.storage.setAlarm(Date.now() + FILE_MAX_AGE_MS);
    return new Response(null, { status: 201 });
  }

  private async get(): Promise<Response> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta) return new Response("gone", { status: 410 });
    const storage = this.ctx.storage;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= meta.chunks) return controller.close();
        const part = await storage.get<Uint8Array>(`c:${i++}`);
        if (!part) return controller.error(new Error("missing chunk"));
        controller.enqueue(part);
      },
    });
    return new Response(stream, { headers: { "Content-Length": String(meta.size) } });
  }

  /** RPC: delete the blob (every target collected it, or the owner's account was deleted). */
  async drop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
