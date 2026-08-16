import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/crawler/checkpoint.js";
import { AppDatabase } from "../src/database/database.js";

const directories: string[]=[];afterEach(()=>{for(const directory of directories.splice(0))fs.rmSync(directory,{recursive:true,force:true});});
describe("checkpoint",()=>{it("round-trips and clears crawl state",()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),"jsb-state-"));directories.push(directory);const database=new AppDatabase(path.join(directory,"test.db"));database.migrate();const store=new CheckpointStore(database.db);store.save("crawl",{keyword:"对数函数",page:17,paperId:"190065",previewPage:4});expect(store.load("crawl")?.previewPage).toBe(4);store.clear("crawl");expect(store.load("crawl")).toBeNull();database.close();});});
