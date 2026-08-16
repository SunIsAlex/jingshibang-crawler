import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "../config.js";

export type SqliteDatabase = Database.Database;

export class AppDatabase {
  readonly db: SqliteDatabase;

  constructor(databasePath = config.databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  migrate(): void {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const schema = fs.readFileSync(path.join(currentDir, "schema.sql"), "utf8");
    this.db.exec(schema);
    this.migrateLegacyImageUniqueness();
  }

  private migrateLegacyImageUniqueness(): void {
    const tableSql = (name: string) => (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { sql?: string } | undefined)?.sql ?? "";
    const assetsLegacy = /UNIQUE\s*\(\s*sha256\s*\)/i.test(tableSql("assets"));
    const pagesLegacy = /UNIQUE\s*\(\s*sha256\s*\)/i.test(tableSql("paper_pages"));
    if (!assetsLegacy && !pagesLegacy) return;

    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        if (assetsLegacy) this.db.exec(`
          ALTER TABLE assets RENAME TO assets_legacy;
          CREATE TABLE assets (
            id INTEGER PRIMARY KEY,
            question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
            remote_url TEXT,
            local_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            downloaded_at TEXT NOT NULL,
            UNIQUE(question_id, sha256)
          );
          INSERT INTO assets SELECT * FROM assets_legacy;
          DROP TABLE assets_legacy;
        `);
        if (pagesLegacy) this.db.exec(`
          ALTER TABLE paper_pages RENAME TO paper_pages_legacy;
          CREATE TABLE paper_pages (
            id INTEGER PRIMARY KEY,
            paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            page_no INTEGER NOT NULL,
            remote_url TEXT,
            local_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            UNIQUE(paper_id, page_no)
          );
          INSERT INTO paper_pages SELECT * FROM paper_pages_legacy;
          DROP TABLE paper_pages_legacy;
        `);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  close(): void { this.db.close(); }
}
