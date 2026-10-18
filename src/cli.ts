#!/usr/bin/env node
import { Command } from "commander";
import { interactiveLogin } from "./browser/session.js";
import { Crawler, type CrawlOptions } from "./crawler/crawler.js";
import { fetchOriginalPdfs, type FetchPdfOptions } from "./crawler/pdf-fetcher.js";
import { DownloadQuotaGuard } from "./crawler/quota.js";
import { AppDatabase } from "./database/database.js";
import { Repository } from "./database/repository.js";
import { Downloader } from "./downloader/downloader.js";
import { MarkdownExporter } from "./exporters/markdown.js";
import { reviewQuestions } from "./review/review.js";
import { logger } from "./utils/logger.js";
import { FigureAssetRefiner } from "./vision/figure-asset-refiner.js";
import { OpenAICompatibleVisionProvider } from "./vision/openai.js";

const program = new Command();
program.name("jingshibang").description("菁师帮题目采集器（正常预览、默认零下载）");

program.command("auth").description("由用户亲自登录并保存本地授权状态").action(interactiveLogin);

program.command("crawl")
  .description("搜索/打开正常详情、读取正常预览、识别并缓存题目")
  .option("--keyword <keyword>").option("--year <year>", "年份", Number)
  .option("--region <region>").option("--grade <grade>").option("--paper <paperId>")
  .option("--page <page>", "列表页", Number).option("--resume").option("--dry-run")
  .option("--refresh", "重新处理已存在且内容未变化的试卷")
  .action(async (options: CrawlOptions) => new Crawler().run(options));

program.command("pdf")
  .description("保存正常预览已加载的试卷原始 PDF（不调用 AI、不发额外请求、不消耗下载额度）")
  .option("--paper <paperId>").option("--keyword <keyword>").option("--year <year>", "年份", Number)
  .option("--region <region>").option("--grade <grade>").option("--page <page>", "列表页", Number)
  .action(async (options: FetchPdfOptions) => fetchOriginalPdfs(options));

program.command("download").description("显式资料下载模块（默认和未验证 endpoint 均 fail-closed）")
  .requiredOption("--resource <resourceId>").action(async ({ resource }) => {
    const database = new AppDatabase(); database.migrate();
    try { await new Downloader(new DownloadQuotaGuard(database.db)).download(resource); }
    finally { database.close(); }
  });

program.command("review").description("人工复核低置信度题目").action(async () => {
  const database = new AppDatabase(); database.migrate(); try { await reviewQuestions(database.db); } finally { database.close(); }
});

program.command("export").description("导出单张试卷")
  .requiredOption("--paper <paperId>").option("--include-answer").option("--format <format>", "markdown|json", "markdown")
  .action(async ({ paper, includeAnswer, format }) => {
    if (!new Set(["markdown", "json"]).has(format)) throw new Error("--format must be markdown or json");
    const database = new AppDatabase(); database.migrate();
    try { console.log(await new MarkdownExporter(new Repository(database.db)).exportPaper(paper, includeAnswer, format)); }
    finally { database.close(); }
  });

program.command("export-topic").description("按专题导出去重题目").requiredOption("--keyword <keyword>")
  .action(async ({ keyword }) => {
    const database = new AppDatabase(); database.migrate();
    try { console.log(await new MarkdownExporter(new Repository(database.db)).exportTopic(keyword)); }
    finally { database.close(); }
  });

program.command("refine-assets").description("从原始来源页重新定位并精确裁切题图")
  .requiredOption("--paper <paperId>").action(async ({ paper }) => {
    const database = new AppDatabase(); database.migrate();
    try {
      const summary = await new FigureAssetRefiner(database.db, new OpenAICompatibleVisionProvider()).refinePaper(paper);
      console.log(JSON.stringify(summary, null, 2));
    } finally { database.close(); }
  });

program.command("db-init").description("初始化 SQLite schema").action(() => {
  const database = new AppDatabase(); database.migrate(); database.close(); logger.info("DATABASE", { initialized: true });
});

program.parseAsync().catch((error: unknown) => {
  logger.error("FATAL", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
