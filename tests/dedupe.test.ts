import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/database/database.js";
import { Repository } from "../src/database/repository.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("question deduplication", () => {
  it("stores identical normalized questions only once and keeps both sources", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jsb-dedupe-")); directories.push(directory);
    const database = new AppDatabase(path.join(directory, "test.db")); database.migrate(); const repository = new Repository(database.db);
    const p1 = repository.upsertPaper({ remoteId: "1", title: "P1", sourceUrl: "https://www.jingshibang.com/home/#/paperDetail?id=1", contentHash: "a" });
    const p2 = repository.upsertPaper({ remoteId: "2", title: "P2", sourceUrl: "https://www.jingshibang.com/home/#/paperDetail?id=2", contentHash: "b" });
    const base = { number: "1", type: "single_choice" as const, stem_markdown: "1. 求 $x$", options: [{ label: "A", markdown: "$1$" }], images: [], confidence: 0.98, uncertain_regions: [], continues_from_previous_page: false, continues_on_next_page: false };
    expect(repository.saveQuestion(p1.id, base, [1], null, 0.98).duplicate).toBe(false);
    expect(repository.saveQuestion(p2.id, { ...base, stem_markdown: "１．  求   $x$" }, [2], null, 0.98).duplicate).toBe(true);
    expect((database.db.prepare("SELECT COUNT(*) count FROM questions").get() as { count: number }).count).toBe(1);
    expect((database.db.prepare("SELECT COUNT(*) count FROM question_sources").get() as { count: number }).count).toBe(2);
    database.close();
  });
});
