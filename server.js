const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 重複防止用キャッシュファイル
const CACHE_PATH = path.resolve(__dirname, 'scraped_jobs.json');
if (!fs.existsSync(CACHE_PATH)) fs.writeFileSync(CACHE_PATH, JSON.stringify({ scraped: [] }, null, 2));

const app = express();
app.use(bodyParser.json());

app.post('/scrape', async (req, res) => {
  const { email, password, url, mode } = req.body;

  if (!email || !password || !url || !mode) {
    return res.status(400).json({ status: 'error', message: 'email, password, url, and mode are required' });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ログイン
    await page.goto('https://hrmos.co/agent/login');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForURL('https://hrmos.co/agent/corporates')
    ]);

    // 処理モードに応じて分岐
    if (mode === 'company_list' && url === 'https://hrmos.co/agent/corporates') {
      await page.goto(url, { waitUntil: 'networkidle' });
      const urls = await page.$$eval('a[href*="/jobs"]', els =>
        Array.from(new Set(els.map(a => a.href)))
      );
      return res.json({ status: 'success', urls });

    } else if (mode === 'job_list' && url.includes('/jobs')) {
      await page.goto(url, { waitUntil: 'networkidle' });
      const jobEntries = await page.$$eval('a[href*="/jobs/"]', els =>
        els.map(a => ({ url: a.href, text: a.textContent || '' }))
      );

      const excludeWords = ['名古屋', '北海道', '沖縄', '福岡', '広島'];
      const filtered = jobEntries.filter(({ text }) => {
        const containsKumikomi = text.includes('組み込み');
        const containsExcludedArea = excludeWords.some(area => text.includes(area));
        return !(containsKumikomi && containsExcludedArea);
      });

      const jobUrls = Array.from(new Set(filtered.map(item => item.url)));
      return res.json({ status: 'success', jobUrls });

    } else if (mode === 'job_detail_urls' && url.includes('/jobs/')) {
      await page.goto(url, { waitUntil: 'networkidle' });
      const detailUrls = await page.$$eval('a[href*="/detail"]', els =>
        Array.from(new Set(els.map(a => a.href)))
      );
      return res.json({ status: 'success', detailUrls });

    } else if (mode === 'scrape_job_details' && url.includes('/detail')) {
      const cache = JSON.parse(fs.readFileSync(CACHE_PATH));
      if (cache.scraped.includes(url)) {
        return res.json({ status: 'skipped', reason: 'Already scraped', url });
      }

      await page.goto(url, { waitUntil: 'networkidle' });
      const jobData = await page.evaluate(() => {
        const getText = selector => {
          const el = document.querySelector(selector);
          return el ? el.innerText.trim() : '';
        };
        return {
          JPS_applied_job_title: getText('h1'),
          JPS_posting_details: getText('article') || document.body.innerText,
          JPS_work_location: getText('section:has(h2:contains("勤務地"))') || '',
          JPS_contract_type: getText('section:has(h2:contains("雇用形態"))') || '',
          JPS_salary: getText('section:has(h2:contains("給与"))') || '',
          JPS_work_schedule: getText('section:has(h2:contains("勤務時間"))') || '',
          JPS_trial_period: getText('section:has(h2:contains("試用期間"))') || '',
          JPS_recruitment_details: getText('article') || '',
          JPS_ideal_candidate_profile: getText('section:has(h2:contains("求める人物像"))') || ''
        };
      });

      cache.scraped.push(url);
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      return res.json({ status: 'success', url, ...jobData });

    } else {
      return res.status(400).json({ status: 'error', message: 'Invalid mode or URL pattern' });
    }
  } catch (error) {
    console.error('Scraping failed:', error);
    res.status(500).json({ status: 'error', message: error.message });
  } finally {
    await browser.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ HRMOS Scraper Server running on port ${port}`));
