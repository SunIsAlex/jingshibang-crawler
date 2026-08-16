import type { SqliteDatabase } from "../database/database.js";

export interface CrawlCheckpoint {
  keyword?: string;
  page?: number;
  paperId?: string;
  previewPage?: number;
  cropIndex?: number;
}

export class CheckpointStore {
  constructor(private readonly db: SqliteDatabase) {}

  save(key: string, checkpoint: CrawlCheckpoint): void {
    this.db.prepare(`
      INSERT INTO crawl_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(key, JSON.stringify(checkpoint), new Date().toISOString());
  }

  load(key: string): CrawlCheckpoint | null {
    const row = this.db.prepare("SELECT value FROM crawl_state WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as CrawlCheckpoint : null;
  }

  clear(key: string): void { this.db.prepare("DELETE FROM crawl_state WHERE key=?").run(key); }
}
