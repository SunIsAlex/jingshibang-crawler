PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY,
  remote_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  year INTEGER,
  region TEXT,
  grade TEXT,
  subject TEXT,
  semester TEXT,
  exam_type TEXT,
  source_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  remote_id TEXT,
  question_type TEXT NOT NULL,
  stem_html TEXT,
  stem_markdown TEXT NOT NULL,
  answer TEXT,
  analysis TEXT,
  difficulty TEXT,
  score REAL,
  content_hash TEXT NOT NULL UNIQUE,
  vision_confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'needs_review',
  question_crop_path TEXT,
  extraction_method TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_sources (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  question_no TEXT NOT NULL,
  source_pages TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (question_id, paper_id, question_no)
);

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  content_html TEXT,
  content_markdown TEXT NOT NULL,
  UNIQUE(question_id, label)
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  remote_url TEXT,
  local_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  downloaded_at TEXT NOT NULL,
  UNIQUE(question_id, sha256)
);

CREATE TABLE IF NOT EXISTS formula_reviews (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  crop_path TEXT NOT NULL,
  formula_markdown TEXT NOT NULL,
  confidence REAL NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(question_id, crop_path)
);

CREATE TABLE IF NOT EXISTS paper_pages (
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

CREATE TABLE IF NOT EXISTS paper_documents (
  id INTEGER PRIMARY KEY,
  paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_url_redacted TEXT,
  local_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  text_layer_pages INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE(paper_id, kind)
);

CREATE TABLE IF NOT EXISTS vision_cache (
  image_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(image_hash, model, prompt_version)
);

CREATE TABLE IF NOT EXISTS figure_location_cache (
  image_hash TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(image_hash, question_hash, model, prompt_version)
);

CREATE TABLE IF NOT EXISTS crawl_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  new_papers INTEGER NOT NULL DEFAULT 0,
  new_questions INTEGER NOT NULL DEFAULT 0,
  updated_questions INTEGER NOT NULL DEFAULT 0,
  duplicate_questions INTEGER NOT NULL DEFAULT 0,
  network_requests INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  vision_requests INTEGER NOT NULL DEFAULT 0,
  vision_cache_hits INTEGER NOT NULL DEFAULT 0,
  failed_requests INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS download_usage (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  download_time TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(date, resource_id)
);

CREATE TABLE IF NOT EXISTS http_cache (
  cache_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  params TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  response_body BLOB,
  etag TEXT,
  last_modified TEXT,
  cached_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_last_seen ON papers(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_questions_review ON questions(review_status, vision_confidence);
CREATE INDEX IF NOT EXISTS idx_question_sources_paper ON question_sources(paper_id, question_no);
CREATE INDEX IF NOT EXISTS idx_download_usage_date ON download_usage(date);
