const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 初回ログイン
  await page.goto('https://hrmos.co/agent/login');
  await page.fill('input[name="email"]', process.env.HRMOS_EMAIL);
  await page.fill('input[name="password"]', process.env.HRMOS_PASS);
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForURL('https://hrmos.co/agent/corporates')
  ]);

  const app = express();
  app.use(bodyParser.json());

  // 1. 企業一覧取得
  app.get('/companies', async (_, res) => {
    await page.goto('https://hrmos.co/agent/corporates', { waitUntil: 'networkidle' });
    await page.waitForSelector('a[href*="/jobs"]', { timeout: 10000 });
    const urls = await page.$$eval('a[href*="/jobs"]', els =>
      Array.from(new Set(els.map(a => a.href)))
    );
    res.json({ urls });
  });

  // 2. 企業ごとの求人一覧取得（除外フィルター付き）
  app.post('/jobs', async (req, res) => {
    const { companyUrl } = req.body;
    await page.goto(companyUrl, { waitUntil: 'networkidle' });

    // すべての求人リンク要素を取得
    const jobEntries = await page.$$eval('a[href*="/jobs/"]', els =>
      els.map(a => ({
        url: a.href,
        text: a.textContent || ''
      }))
    );

    // 除外条件
    const excludeWords = ['名古屋', '北海道', '沖縄', '福岡', '広島'];
    const filtered = jobEntries.filter(({ text }) => {
      const containsKumikomi = text.includes('組み込み');
      const containsExcludedArea = excludeWords.some(area => text.includes(area));
      // 組み込み + 地方 → 除外
      return !(containsKumikomi && containsExcludedArea);
    });

    // URLだけ返す
    const jobUrls = Array.from(new Set(filtered.map(item => item.url)));
    res.json({ jobUrls });
  });

  // 3. 求人ごとの詳細ページURL取得（/detail を含むリンク）
  app.post('/job-details', async (req, res) => {
    const { jobUrl } = req.body;
    await page.goto(jobUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('a[href*="/detail"]', { timeout: 10000 });
    const detailUrls = await page.$$eval('a[href*="/detail"]', els =>
      Array.from(new Set(els.map(a => a.href)))
    );
    res.json({ detailUrls });
  });

  // 4. 求人詳細ページHTML取得
  app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    await page.goto(url, { waitUntil: 'networkidle' });
    try {
      await page.waitForSelector('article', { timeout: 5000 });
      const html = await page.$eval('article', el => el.innerHTML);
      res.json({ url, html });
    } catch (e) {
      const fallback = await page.content();
      res.json({ url, html: fallback });
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`✅ Server running on port ${port}`));
})();
