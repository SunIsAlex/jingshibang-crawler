import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

export async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, filePath);
}
