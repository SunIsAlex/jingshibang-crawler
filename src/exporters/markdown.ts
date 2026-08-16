import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { Repository } from "../database/repository.js";
import { atomicWrite, ensureDir } from "../utils/files.js";
import { sha256 } from "../utils/hash.js";
import { normalizeLatexTranscript } from "../utils/normalize.js";

const typeTitles: Record<string, string> = {
  single_choice: "单选题", multiple_choice: "多选题", fill_blank: "填空题",
  short_answer: "解答题", proof: "证明题", true_false: "判断题", unknown: "其他题型",
};

export class MarkdownExporter {
  constructor(private readonly repository: Repository) {}

  async exportPaper(remoteId: string, includeAnswer = false, format: "markdown" | "json" = "markdown"): Promise<string> {
    const paper = this.repository.getPaperByRemoteId(remoteId);
    if (!paper) throw new Error(`Paper ${remoteId} is not in the database`);
    const questions = this.repository.listPaperQuestions(remoteId).map((question) => ({
      ...question,
      stem_markdown: normalizeLatexTranscript(String(question.stem_markdown)),
      answer: question.answer == null ? question.answer : normalizeLatexTranscript(String(question.answer)),
      analysis: question.analysis == null ? question.analysis : normalizeLatexTranscript(String(question.analysis)),
      options: this.repository.listOptions(Number(question.id)).map((option) => ({
        ...option, content_markdown: normalizeLatexTranscript(option.content_markdown),
      })),
      assets: this.repository.listAssets(Number(question.id)),
    })) as Array<Record<string, unknown> & { options: Array<{ label: string; content_markdown: string }>;
      assets: Array<{ local_path: string; sha256: string; mime_type: string }> }>;
    const directory = path.join(config.outputDir, remoteId); await ensureDir(path.join(directory, "images"));
    for (const question of questions) await this.copyAssets(question.assets, directory);
    if (format === "json") {
      const outputPath = path.join(directory, "index.json");
      await atomicWrite(outputPath, JSON.stringify({ paper, questions: questions.map((question) => includeAnswer ? question : { ...question, answer: undefined, analysis: undefined }) }, null, 2));
      return outputPath;
    }
    const grouped = new Map<string, typeof questions>();
    for (const question of questions) {
      const type = String(question.question_type); const group = grouped.get(type) ?? []; group.push(question); grouped.set(type, group);
    }
    const lines = [`# ${paper.title}`, ""];
    for (const [type, items] of grouped) {
      lines.push(`## ${typeTitles[type] ?? typeTitles.unknown}`, "");
      for (const question of items) {
        lines.push(`### ${question.question_no}.`, "", String(question.stem_markdown), "");
        for (const option of question.options) lines.push(`**${option.label}.** ${option.content_markdown}`, "");
        for (const asset of question.assets) lines.push(`![第 ${question.question_no} 题原图](images/${asset.sha256}.png)`, "");
        if (includeAnswer && question.answer) lines.push(`**答案：** ${String(question.answer)}`, "");
        if (includeAnswer && question.analysis) lines.push(`**解析：** ${String(question.analysis)}`, "");
      }
    }
    const outputPath = path.join(directory, "index.md"); await atomicWrite(outputPath, lines.join("\n")); return outputPath;
  }

  async exportTopic(keyword: string): Promise<string> {
    const questions = this.repository.listTopicQuestions(keyword);
    const slug = `topic-${sha256(keyword).slice(0, 10)}`;
    const directory = path.join(config.outputDir, "topics", slug); await ensureDir(path.join(directory, "images"));
    const lines = [`# ${keyword}题目汇编`, ""];
    let index = 0;
    for (const question of questions) {
      index += 1; lines.push(`### ${index}.`, "", normalizeLatexTranscript(String(question.stem_markdown)), "");
      for (const option of this.repository.listOptions(Number(question.id))) {
        lines.push(`**${option.label}.** ${normalizeLatexTranscript(option.content_markdown)}`, "");
      }
      const assets = this.repository.listAssets(Number(question.id)); await this.copyAssets(assets, directory);
      for (const asset of assets) lines.push(`![第 ${index} 题原图](images/${asset.sha256}.png)`, "");
      const sources = String(question.source_titles ?? "").split(",").filter(Boolean);
      if (sources.length) { lines.push("**来源：**", ""); for (const source of sources) lines.push(`- ${source}`); lines.push(""); }
    }
    const outputPath = path.join(directory, "index.md"); await atomicWrite(outputPath, lines.join("\n")); return outputPath;
  }

  private async copyAssets(assets: Array<{ local_path: string; sha256: string }>, directory: string): Promise<void> {
    for (const asset of assets) {
      const destination = path.join(directory, "images", `${asset.sha256}.png`);
      try { await fs.copyFile(asset.local_path, destination, fs.constants.COPYFILE_EXCL); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}
