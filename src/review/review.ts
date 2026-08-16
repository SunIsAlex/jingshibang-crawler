import readline from "node:readline/promises";
import type { SqliteDatabase } from "../database/database.js";

export async function reviewQuestions(db: SqliteDatabase): Promise<void> {
  const rows = db.prepare(`
    SELECT q.id,q.stem_markdown,q.vision_confidence,q.question_crop_path,q.review_status,
      (SELECT crop_path FROM formula_reviews fr WHERE fr.question_id=q.id ORDER BY id DESC LIMIT 1) AS formula_crop_path,
      (SELECT formula_markdown FROM formula_reviews fr WHERE fr.question_id=q.id ORDER BY id DESC LIMIT 1) AS formula_markdown
    FROM questions q WHERE q.review_status!='confirmed' ORDER BY q.vision_confidence ASC LIMIT 100
  `).all() as Array<{ id: number; stem_markdown: string; vision_confidence: number; question_crop_path: string | null;
    review_status: string; formula_crop_path: string | null; formula_markdown: string | null }>;
  if (!rows.length) { console.log("没有待复核题目。"); return; }
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const row of rows) {
      console.log("\n========== Review =========="); console.log(`ID: ${row.id}`); console.log(`置信度: ${row.vision_confidence}`);
      console.log(`原题图片: ${row.question_crop_path ?? "无"}`); console.log(row.stem_markdown);
      if (row.formula_crop_path) console.log(`局部公式图片: ${row.formula_crop_path}\n局部复核: ${row.formula_markdown}`);
      const answer = (await input.question("确认忠实转录？[y]es / [s]kip / [q]uit: ")).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "y") db.prepare("UPDATE questions SET review_status='confirmed',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    }
  } finally { input.close(); }
}
