import type { ExtractedQuestion } from "../parsing/schemas.js";
import { questionContentHash, normalizeQuestionText } from "../utils/normalize.js";
import type { SqliteDatabase } from "./database.js";

const now = () => new Date().toISOString();

export interface PaperRecordInput {
  remoteId: string;
  title: string;
  year?: number | null;
  region?: string | null;
  grade?: string | null;
  subject?: string | null;
  semester?: string | null;
  examType?: string | null;
  sourceUrl: string;
  contentHash: string;
}

export interface QuestionSaveResult {
  id: number;
  duplicate: boolean;
  contentHash: string;
}

export interface CrawlRunStats {
  newPapers: number;
  newQuestions: number;
  updatedQuestions: number;
  duplicateQuestions: number;
  networkRequests: number;
  cacheHits: number;
  visionRequests: number;
  visionCacheHits: number;
  failedRequests: number;
}

export class Repository {
  constructor(private readonly db: SqliteDatabase) {}

  upsertPaper(input: PaperRecordInput): { id: number; created: boolean; changed: boolean } {
    const existing = this.db.prepare("SELECT id, content_hash FROM papers WHERE remote_id = ?").get(input.remoteId) as
      | { id: number; content_hash: string }
      | undefined;
    const timestamp = now();
    if (!existing) {
      const result = this.db.prepare(`
        INSERT INTO papers(remote_id,title,year,region,grade,subject,semester,exam_type,source_url,first_seen_at,last_seen_at,content_hash)
        VALUES(@remoteId,@title,@year,@region,@grade,@subject,@semester,@examType,@sourceUrl,@firstSeen,@lastSeen,@contentHash)
      `).run({ ...input, year: input.year ?? null, region: input.region ?? null, grade: input.grade ?? null,
        subject: input.subject ?? null, semester: input.semester ?? null, examType: input.examType ?? null,
        firstSeen: timestamp, lastSeen: timestamp });
      return { id: Number(result.lastInsertRowid), created: true, changed: true };
    }
    const changed = existing.content_hash !== input.contentHash;
    this.db.prepare(`
      UPDATE papers SET title=@title,year=@year,region=@region,grade=@grade,subject=@subject,
      semester=@semester,exam_type=@examType,source_url=@sourceUrl,last_seen_at=@lastSeen,content_hash=@contentHash
      WHERE id=@id
    `).run({ ...input, id: existing.id, year: input.year ?? null, region: input.region ?? null,
      grade: input.grade ?? null, subject: input.subject ?? null, semester: input.semester ?? null,
      examType: input.examType ?? null, lastSeen: timestamp });
    return { id: existing.id, created: false, changed };
  }

  saveQuestion(
    paperId: number,
    question: ExtractedQuestion,
    sourcePages: number[],
    cropPath: string | null,
    finalConfidence: number,
    imageHashes: string[] = [],
  ): QuestionSaveResult {
    const contentHash = questionContentHash({ stemMarkdown: question.stem_markdown, options: question.options, imageHashes });
    const existing = this.db.prepare("SELECT id FROM questions WHERE content_hash = ?").get(contentHash) as { id: number } | undefined;
    let questionId: number;
    const reviewStatus = finalConfidence >= 0.95 ? "confirmed" : finalConfidence >= 0.8 ? "auto_review" : "needs_review";
    const timestamp = now();

    const transaction = this.db.transaction(() => {
      if (existing) {
        questionId = existing.id;
      } else {
        const result = this.db.prepare(`
          INSERT INTO questions(question_type,stem_markdown,content_hash,vision_confidence,review_status,question_crop_path,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(question.type, normalizeQuestionText(question.stem_markdown), contentHash, finalConfidence, reviewStatus, cropPath, timestamp, timestamp);
        questionId = Number(result.lastInsertRowid);
        const insertOption = this.db.prepare(`
          INSERT INTO options(question_id,label,content_markdown) VALUES(?,?,?)
        `);
        for (const option of question.options) {
          insertOption.run(questionId, option.label.trim().toUpperCase(), normalizeQuestionText(option.markdown));
        }
      }
      this.db.prepare(`
        INSERT INTO question_sources(question_id,paper_id,question_no,source_pages)
        VALUES(?,?,?,?) ON CONFLICT(question_id,paper_id,question_no) DO UPDATE SET source_pages=excluded.source_pages
      `).run(questionId!, paperId, question.number, JSON.stringify(sourcePages));
    });
    transaction();
    return { id: questionId!, duplicate: Boolean(existing), contentHash };
  }

  saveAsset(input: {
    questionId: number; remoteUrl?: string | null; localPath: string; sha256: string; mimeType: string;
  }): void {
    this.db.prepare(`
      INSERT INTO assets(question_id,remote_url,local_path,sha256,mime_type,downloaded_at)
      VALUES(@questionId,@remoteUrl,@localPath,@sha256,@mimeType,@downloadedAt)
      ON CONFLICT(question_id,sha256) DO UPDATE SET
        remote_url=excluded.remote_url,local_path=excluded.local_path,mime_type=excluded.mime_type
    `).run({ ...input, remoteUrl: input.remoteUrl ?? null, downloadedAt: now() });
  }

  listAssets(questionId: number): Array<{ local_path: string; sha256: string; mime_type: string }> {
    return this.db.prepare("SELECT local_path,sha256,mime_type FROM assets WHERE question_id=? ORDER BY id")
      .all(questionId) as Array<{ local_path: string; sha256: string; mime_type: string }>;
  }

  listPaperImageCandidates(remoteId: string): Array<{
    question_id: number; question_no: string; stem_markdown: string; source_pages: string;
  }> {
    return this.db.prepare(`
      SELECT DISTINCT q.id AS question_id,qs.question_no,q.stem_markdown,qs.source_pages
      FROM questions q JOIN question_sources qs ON qs.question_id=q.id
      JOIN papers p ON p.id=qs.paper_id JOIN assets a ON a.question_id=q.id
      WHERE p.remote_id=? ORDER BY CAST(qs.question_no AS INTEGER),qs.question_no
    `).all(remoteId) as Array<{ question_id: number; question_no: string; stem_markdown: string; source_pages: string }>;
  }

  replaceQuestionAssets(questionId: number, assets: Array<{ localPath: string; sha256: string; mimeType: string }>): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM assets WHERE question_id=?").run(questionId);
      for (const asset of assets) this.saveAsset({ questionId, localPath: asset.localPath, sha256: asset.sha256, mimeType: asset.mimeType });
      const question = this.db.prepare("SELECT stem_markdown FROM questions WHERE id=?").get(questionId) as { stem_markdown: string };
      const options = this.listOptions(questionId).map((option) => ({ label: option.label, markdown: option.content_markdown }));
      const contentHash = questionContentHash({ stemMarkdown: question.stem_markdown, options, imageHashes: assets.map((asset) => asset.sha256) });
      this.db.prepare("UPDATE questions SET content_hash=?,updated_at=? WHERE id=?").run(contentHash, now(), questionId);
    })();
  }

  saveFormulaReview(input: {
    questionId: number; cropPath: string; formulaMarkdown: string; confidence: number; issues: string[];
  }): void {
    this.db.prepare(`
      INSERT INTO formula_reviews(question_id,crop_path,formula_markdown,confidence,issues_json,created_at)
      VALUES(@questionId,@cropPath,@formulaMarkdown,@confidence,@issuesJson,@createdAt)
      ON CONFLICT(question_id,crop_path) DO UPDATE SET formula_markdown=excluded.formula_markdown,
        confidence=excluded.confidence,issues_json=excluded.issues_json,created_at=excluded.created_at
    `).run({ ...input, issuesJson: JSON.stringify(input.issues), createdAt: now() });
  }

  savePaperPage(input: {
    paperId: number; pageNo: number; remoteUrl?: string | null; localPath: string;
    sha256: string; width: number; height: number;
  }): void {
    this.db.prepare(`
      INSERT INTO paper_pages(paper_id,page_no,remote_url,local_path,sha256,width,height)
      VALUES(@paperId,@pageNo,@remoteUrl,@localPath,@sha256,@width,@height)
      ON CONFLICT(paper_id,page_no) DO UPDATE SET
        remote_url=excluded.remote_url,local_path=excluded.local_path,sha256=excluded.sha256,
        width=excluded.width,height=excluded.height
    `).run({ ...input, remoteUrl: input.remoteUrl ?? null });
  }

  getPaperByRemoteId(remoteId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM papers WHERE remote_id = ?").get(remoteId) as Record<string, unknown> | undefined;
  }

  paperQuestionCount(paperId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM question_sources WHERE paper_id=?").get(paperId) as { count: number };
    return row.count;
  }

  replacePaperSources(paperId: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM question_sources WHERE paper_id=?").run(paperId);
      this.db.prepare("DELETE FROM questions WHERE NOT EXISTS (SELECT 1 FROM question_sources qs WHERE qs.question_id=questions.id)").run();
    })();
  }

  startCrawlRun(): number {
    const result = this.db.prepare("INSERT INTO crawl_runs(started_at) VALUES(?)").run(now());
    return Number(result.lastInsertRowid);
  }

  finishCrawlRun(runId: number, stats: CrawlRunStats): void {
    this.db.prepare(`
      UPDATE crawl_runs SET finished_at=@finishedAt,new_papers=@newPapers,new_questions=@newQuestions,
      updated_questions=@updatedQuestions,duplicate_questions=@duplicateQuestions,
      network_requests=@networkRequests,cache_hits=@cacheHits,vision_requests=@visionRequests,
      vision_cache_hits=@visionCacheHits,failed_requests=@failedRequests WHERE id=@runId
    `).run({ runId, finishedAt: now(), ...stats });
  }

  listPaperQuestions(remoteId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT q.*, qs.question_no, qs.source_pages
      FROM questions q JOIN question_sources qs ON qs.question_id=q.id
      JOIN papers p ON p.id=qs.paper_id WHERE p.remote_id=?
      ORDER BY CAST(qs.question_no AS INTEGER), qs.question_no
    `).all(remoteId) as Array<Record<string, unknown>>;
  }

  listOptions(questionId: number): Array<{ label: string; content_markdown: string }> {
    return this.db.prepare("SELECT label,content_markdown FROM options WHERE question_id=? ORDER BY id").all(questionId) as Array<{ label: string; content_markdown: string }>;
  }

  listTopicQuestions(keyword: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT q.*, GROUP_CONCAT(DISTINCT p.title) AS source_titles
      FROM questions q JOIN question_sources qs ON qs.question_id=q.id
      JOIN papers p ON p.id=qs.paper_id
      WHERE p.title LIKE ? OR p.subject LIKE ? OR p.exam_type LIKE ?
      GROUP BY q.id ORDER BY q.question_type, q.id
    `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) as Array<Record<string, unknown>>;
  }
}
