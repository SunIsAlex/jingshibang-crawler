import { DownloadQuotaGuard } from "../crawler/quota.js";

export class Downloader {
  constructor(private readonly quota: DownloadQuotaGuard) {}

  async download(resourceId: string): Promise<never> {
    this.quota.assertAllowed(resourceId);
    throw new Error(
      "Download endpoint is intentionally not implemented: the real quota-consuming request has not been safely verified. " +
      "No request was sent and no quota record was created.",
    );
  }
}
