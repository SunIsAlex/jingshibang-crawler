import { AppDatabase } from "../src/database/database.js";

const remoteId = process.argv[2];
if (!remoteId || !/^\d+$/.test(remoteId)) throw new Error("Usage: npm run report -- <paperId>");

const database = new AppDatabase();
try {
  database.migrate();
  const rows = database.db.prepare(`
    SELECT qs.question_no,qs.source_pages,q.question_type,q.review_status,
      ROUND(q.vision_confidence,2) AS confidence,
      (SELECT COUNT(*) FROM options o WHERE o.question_id=q.id) AS option_count,
      (SELECT COUNT(*) FROM assets a WHERE a.question_id=q.id) AS asset_count
    FROM questions q JOIN question_sources qs ON qs.question_id=q.id
    JOIN papers p ON p.id=qs.paper_id WHERE p.remote_id=?
    ORDER BY CAST(qs.question_no AS INTEGER),qs.question_no
  `).all(remoteId);
  const answerMarkers = database.db.prepare(`
    SELECT COUNT(*) AS count FROM questions q JOIN question_sources qs ON qs.question_id=q.id
    JOIN papers p ON p.id=qs.paper_id WHERE p.remote_id=?
      AND (q.stem_markdown LIKE '%【详解】%' OR q.stem_markdown LIKE '%参考答案%')
  `).get(remoteId) as { count: number };
  const storedAnswers = database.db.prepare(`
    SELECT COUNT(*) AS count FROM questions q JOIN question_sources qs ON qs.question_id=q.id
    JOIN papers p ON p.id=qs.paper_id WHERE p.remote_id=? AND (q.answer IS NOT NULL OR q.analysis IS NOT NULL)
  `).get(remoteId) as { count: number };
  const recentRuns = database.db.prepare(`
    SELECT id,started_at,finished_at,new_papers,new_questions,duplicate_questions,
      network_requests,cache_hits,vision_requests,vision_cache_hits,failed_requests
    FROM crawl_runs ORDER BY id DESC LIMIT 5
  `).all();
  console.log(JSON.stringify({ paperId: remoteId, questionCount: rows.length,
    answerMarkerCount: answerMarkers.count, storedAnswerCount: storedAnswers.count, questions: rows, recentRuns }, null, 2));
} finally {
  database.close();
}
