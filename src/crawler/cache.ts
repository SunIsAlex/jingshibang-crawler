import type { SqliteDatabase } from "../database/database.js";
import { sha256 } from "../utils/hash.js";

export interface HttpCacheEntry {
  body: Buffer;
  etag: string | null;
  lastModified: string | null;
  cachedAt: string;
}

export class HttpCache {
  constructor(private readonly db: SqliteDatabase) {}

  key(url: string, params: Record<string, string> = {}): string {
    const normalized = new URL(url);
    normalized.searchParams.delete("token");
    return sha256(`${normalized.toString()}\n${JSON.stringify(Object.entries(params).sort())}`);
  }

  get(url: string, params: Record<string, string> = {}): HttpCacheEntry | null {
    const row = this.db.prepare("SELECT response_body,etag,last_modified,cached_at FROM http_cache WHERE cache_key=?")
      .get(this.key(url, params)) as { response_body: Buffer | null; etag: string | null; last_modified: string | null; cached_at: string } | undefined;
    return row?.response_body ? { body: row.response_body, etag: row.etag, lastModified: row.last_modified, cachedAt: row.cached_at } : null;
  }

  put(url: string, params: Record<string, string>, body: Buffer, headers: { etag?: string | null; lastModified?: string | null }): void {
    const safeUrl = new URL(url); safeUrl.searchParams.delete("token");
    this.db.prepare(`
      INSERT INTO http_cache(cache_key,url,params,response_hash,response_body,etag,last_modified,cached_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET
      response_hash=excluded.response_hash,response_body=excluded.response_body,etag=excluded.etag,
      last_modified=excluded.last_modified,cached_at=excluded.cached_at
    `).run(this.key(url, params), safeUrl.toString(), JSON.stringify(params), sha256(body), body,
      headers.etag ?? null, headers.lastModified ?? null, new Date().toISOString());
  }
}
