const allowedOrigin = "https://www.jingshibang.com";
const forbiddenPath = /\/(?:download|downloads|basket|checkout|order|pay)(?:\/|$)/i;
const allowedApiPath = [
  /^\/api\/products$/,
  /^\/api\/product\/detail\/\d+$/,
  /^\/api\/public\/filepreview$/,
  /^\/api\/store\/getcategory$/,
  /^\/api\/city\/searchConfig$/,
  /^\/api\/smallclass\/recommendlist$/,
  /^\/api\/cart\/count$/,
  /^\/api\/yunoss\/get_license_key$/,
  /^\/api\/myupload\/choose_question$/,
];

export class RequestSafetyGuard {
  private readonly discoveredPaperIds = new Set<string>();

  registerPaperId(paperId: string): void {
    if (!/^\d+$/.test(paperId)) throw new Error(`Invalid paper id: ${paperId}`);
    this.discoveredPaperIds.add(paperId);
  }

  assertKnownPaperId(paperId: string, explicitlyRequested = false): void {
    if (!/^\d+$/.test(paperId)) throw new Error("Paper id must be numeric");
    if (!explicitlyRequested && !this.discoveredPaperIds.has(paperId)) {
      throw new Error(`Paper ${paperId} was not discovered through a normal list page`);
    }
  }

  assertAllowedRequest(rawUrl: string, purpose: "page" | "api" | "preview"): URL {
    const url = new URL(rawUrl);
    if (url.origin !== allowedOrigin) throw new Error(`Blocked cross-origin request to ${url.origin}`);
    if (forbiddenPath.test(url.pathname)) throw new Error(`Blocked download/payment path: ${url.pathname}`);

    if (purpose === "page") {
      if (!url.pathname.startsWith("/home/")) throw new Error(`Blocked non-home page: ${url.pathname}`);
      return url;
    }

    if (!allowedApiPath.some((pattern) => pattern.test(url.pathname))) {
      throw new Error(`API path is not on the observed allowlist: ${url.pathname}`);
    }
    if (purpose === "preview" && url.pathname !== "/api/public/filepreview") {
      throw new Error("Preview requests must use the observed filepreview route");
    }
    return url;
  }
}
