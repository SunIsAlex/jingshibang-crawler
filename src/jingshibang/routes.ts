const base = "https://www.jingshibang.com";

export const routes = {
  home: `${base}/home/#/`,
  search: (keyword: string) => `${base}/home/#/seachList?key=${encodeURIComponent(keyword)}`,
  paperDetail: (paperId: string, title = "") =>
    `${base}/home/#/paperDetail?id=${encodeURIComponent(paperId)}&title=${encodeURIComponent(title)}&from=${encodeURIComponent("试卷")}&video=0`,
  productsApi: `${base}/api/products`,
  productDetailApi: (paperId: string) => `${base}/api/product/detail/${encodeURIComponent(paperId)}`,
} as const;
