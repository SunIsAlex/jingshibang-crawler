import type { SqliteDatabase } from "../database/database.js";
import { extractedQuestionSchema, type ExtractedQuestion } from "../parsing/schemas.js";

export class VisionCache {
  constructor(private readonly db: SqliteDatabase) {}

  get(imageHash: string, model: string, promptVersion: string): ExtractedQuestion[] | null {
    const row = this.db.prepare(`SELECT result_json FROM vision_cache WHERE image_hash=? AND model=? AND prompt_version=?`)
      .get(imageHash, model, promptVersion) as { result_json: string } | undefined;
    if (!row) return null;
    return extractedQuestionSchema.array().parse(JSON.parse(row.result_json));
  }

  put(imageHash: string, model: string, promptVersion: string, result: ExtractedQuestion[]): void {
    this.db.prepare(`
      INSERT INTO vision_cache(image_hash,model,prompt_version,result_json,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(image_hash,model,prompt_version) DO UPDATE SET result_json=excluded.result_json,created_at=excluded.created_at
    `).run(imageHash, model, promptVersion, JSON.stringify(result), new Date().toISOString());
  }
}
