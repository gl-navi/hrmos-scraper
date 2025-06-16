const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

(async () => {
  // ブラウザ＆コンテキスト起動
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

  // 企業一覧取得
    app.get('/companies', async (_, res) => {
    console.log('Navigating to HRMOS corporates list...');
    await page.goto('https://hrmos.co/agent/corporates', { waitUntil: 'networkidle' });

    // Angular が描画するリンクを待機（最大10秒）
    await page.waitForSelector('a[href*="/jobs"]', { timeout: 10000 });

    // リンクを取得（重複除去）
    const urls = await page.$$eval('a[href*="/jobs"]', els =>
        Array.from(new Set(els.map(a => a.href)))
    );

    console.log("Extracted company job URLs:", urls);
    res.json({ urls });
    });


  // 企業ごとの求人一覧取得
  app.post('/jobs', async (req, res) => {
    const { companyUrl } = req.body;
    await page.goto(companyUrl, { waitUntil: 'networkidle' });
    const jobUrls = await page.$$eval('.job-list-item a', els => els.map(a => a.href));
    res.json({ jobUrls });
  });

  // 求人詳細ページ取得
  app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    await page.goto(url, { waitUntil: 'networkidle' });
    const html = await page.$eval('article', el => el.innerHTML).catch(() => '');
    res.json({ url, html });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server listening on port ${port}`));
})();
