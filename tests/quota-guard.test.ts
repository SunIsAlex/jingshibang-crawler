import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadQuotaGuard, VisionBudgetGuard } from "../src/crawler/quota.js";
import { AppDatabase } from "../src/database/database.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe("quota guards", () => {
  it("blocks downloads by default", () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"jsb-quota-"));directories.push(directory);const database=new AppDatabase(path.join(directory,"test.db"));database.migrate();
    expect(() => new DownloadQuotaGuard(database.db, 0).assertAllowed("x", "2026-01-01")).toThrow(/disabled/); database.close();
  });
  it("stops exactly at configured quota", () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"jsb-quota-"));directories.push(directory);const database=new AppDatabase(path.join(directory,"test.db"));database.migrate();const guard=new DownloadQuotaGuard(database.db,1);
    guard.assertAllowed("a","2026-01-01");guard.record("a","success","2026-01-01");expect(()=>guard.assertAllowed("b","2026-01-01")).toThrow(/reached/);database.close();
  });
  it("enforces vision request and image budgets", () => { const guard=new VisionBudgetGuard(1,2);guard.assertCanRequest(2);guard.recordRequest(2);expect(()=>guard.assertCanRequest(1)).toThrow(/request budget/); });
});
