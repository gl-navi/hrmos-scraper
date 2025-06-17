/**************************************************************************
 * HRMOS スクレイパー サーバー (Express + Playwright) ★stream 版
 **************************************************************************/
const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

const PORT        = process.env.PORT || 3000;
const LOGIN_URL   = 'https://hrmos.co/agent/login';
const CORP_TOP    = 'https://hrmos.co/agent/corporates';
const LOCAL_WORDS = ['名古屋','愛知','北海道','沖縄','福岡','広島'];

let browser;

/* ---------- 共通ブラウザインスタンス ---------- */
async function ensureBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
}

/* ---------- ログイン ---------- */
async function login(email, password) {
  await ensureBrowser();
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForURL(CORP_TOP, { timeout: 15000 })
  ]);
  return { page, context };
}

/* ---------- 企業一覧 ---------- */
async function fetchCompanies(page) {
  await page.goto(CORP_TOP, { waitUntil: 'networkidle' });
  return await page.$$eval('a[href*="/jobs"]', els => {
    const seen = new Set();
    return els.map(a => {
      const href = a.href;
      if (seen.has(href)) return null;
      seen.add(href);
      const raw = (a.querySelector('.normal')?.innerText || a.textContent).trim();
      return { companyName: raw.split(/Invited/i)[0].trim(), companyJobsUrl: href };
    }).filter(Boolean);
  });
}

/* ---------- 求人一覧 (1社分) ---------- */
async function fetchJobItems(page, companyJobsUrl) {
  await page.goto(companyJobsUrl, { waitUntil: 'networkidle' });
  return await page.$$eval('a[href*="/jobs/"]', (els, LOCAL_WORDS) => {
    const items = [];
    for (const a of els) {
      const raw = (a.querySelector('.normal')?.innerText || a.textContent).trim();
      const t   = raw.replace(/@\{[^}]+\}/g, '').split(/Invited/i)[0].trim();
      if (!t) continue;
      if (t.includes('組み込み') || LOCAL_WORDS.some(l => t.includes(l))) continue;
      items.push({ title: t, url: a.href });
    }
    const seen = new Set();
    return items.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; });
  }, LOCAL_WORDS);
}

/* ---------- 詳細ページ URL 群 ---------- */
async function fetchDetailUrls(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: 'networkidle' });
  return await page.$$eval('a[href*="/detail"]', els => Array.from(new Set(els.map(a => a.href))));
}

/* ---------- detail ページスクレイピング (tbody 対応版) ---------- */
async function scrapeDetail(page, detailUrl) {
  await page.goto(detailUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1,h2,dt', { timeout: 8000 });

  return await page.evaluate(detailUrl => {

    /* === UTILS ======================================================= */
    /** element を整形して innerText を返す（<br>→\n , <li>→"• " , 画像除去） */
    function getFormattedText(el) {
      const clone = el.cloneNode(true);

      /* 画像・図を完全除去 */
      clone.querySelectorAll('img,picture,svg').forEach(n => n.remove());

      /* <br> → 改行 */
      clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

      /* <li> → "• " */
      clone.querySelectorAll('li').forEach(li => {
        li.insertAdjacentText('afterbegin', '• ');
      });

      /* 連続改行を整理 */
      return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
    }

    /** ラベルにマッチする値を取得 */
    function extractByLabels(labels, joinAll = false) {
      const isMatch = txt => labels.some(l => txt && txt.trim().includes(l));
      const results = [];

      /* th / dt */
      for (const el of document.querySelectorAll('th,dt')) {
        if (isMatch(el.innerText)) {
          const val = el.nextElementSibling || el.parentElement.querySelector('td,dd');
          if (val) results.push(getFormattedText(val));
        }
      }

      /* 見出し */
      for (const h of document.querySelectorAll('h1,h2,h3,strong,b')) {
        if (isMatch(h.innerText)) {
          let n = h.nextElementSibling;
          while (n && n.innerText.trim() === '') n = n.nextElementSibling;
          if (n) results.push(getFormattedText(n));
        }
      }
      return joinAll ? results.join('\n') : (results[0] || '');
    }

    /* === 1. 本文 (tbody 全部) ======================================== */
    let postingDetails = '';
    const tbodies = Array.from(document.querySelectorAll('tbody'))
      .map(tb => getFormattedText(tb))
      .filter(t => t.length);

    if (tbodies.length) {
      postingDetails = tbodies.join('\n\n');          // tbody ごと 1 行空け
    } else {
      /* フォールバック: 従来ロジック */
      const bodyBlocks = Array.from(
        document.querySelectorAll('section, div, article')
      ).filter(e => (e.innerText || '').length > 200);

      if (bodyBlocks.length) {
        postingDetails = getFormattedText(
          bodyBlocks.sort((a, b) => b.innerText.length - a.innerText.length)[0]
        );
      }
    }
　
    /* === 2. 応募資格 ================================================= */
    let recruitmentDetails = '';
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,strong,b'))
      .find(h => /応募資格/.test(h.innerText));

    if (heading) {
      const parts = [];
      const stopTags = new Set(['H1','H2','H3','STRONG','B']);
      let n = heading.nextElementSibling;
      while (n && !stopTags.has(n.tagName)) {
        if ((n.innerText || '').trim()) parts.push(getFormattedText(n));
        n = n.nextElementSibling;
      }
      recruitmentDetails = parts.join('\n');
    }

    /* === 3. その他フィールド ========================================= */
    const salaryBlock   = extractByLabels(['給与','想定年収'], true);
    const salaryFirst   = salaryBlock.split(/\r?\n/)[0].trim();
    const workTimeBlock = extractByLabels(['勤務時間','勤務時間・曜日'], true);
    const workCondKeys  = ['固定時間制','変動勤務時間制','フレックスタイム制','裁量勤務制'];
    const workingCondMatch = workCondKeys.find(k => salaryBlock.includes(k) || workTimeBlock.includes(k)) || '';
    const idealProfile = extractByLabels(['求める人物像','歓迎する経歴','応募資格（WANT）'], true);

    /* === 4. 結果オブジェクト ======================================== */
    return {
      detailUrl,
      JPS_applied_job_title          : extractByLabels(['求人タイトル']),
      JPS_occupation_category        : extractByLabels(['職種','募集ポジション']),
      JPS_position_department        : '',
      JPS_position_priority          : '',
      JPS_revenue                    : '',
      JPS_overseas_residency_check   : '',
      JPS_OPPreferral_fee_percentage : '',
      JPS_display_language           : '日本語',
      JPS_contract_type              : extractByLabels(['雇用形態']),
      JPS_work_location              : extractByLabels(['勤務地']),
      JPS_salary                     : salaryFirst,
      JPS_working_conditions         : workingCondMatch,
      JPS_work_schedule              : workTimeBlock,
      JPS_trial_period               : '',
      JPS_trial_period_others        : '',
      JPS_recruitment_details        : recruitmentDetails,
      JPS_ideal_candidate_profile    : idealProfile,
      JPS_posting_details            : postingDetails
    };
  }, detailUrl);
}

/* ---------- Express ハンドラ ---------- */
const app = express();
app.use(bodyParser.json());

app.post('/scrape', async (req, res) => {
  const { site = 'hrmos', email, password, url, stopAt = 'details' } = req.body;
  if (site !== 'hrmos')                 return res.status(400).end('site must be hrmos');
  if (!email || !password || !url)      return res.status(400).end('email,password,url 必須');
  if (!['companies','jobs','details'].includes(stopAt))
    return res.status(400).end('stopAt is invalid');

  const { page, context } = await login(email, password);

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Transfer-Encoding': 'chunked'
  });
  res.write('[');
  let first = true;
  const writeObj = obj => {
    res.write((first ? '' : ',') + JSON.stringify(obj));
    first = false;
  };

  try {
    /* 単一 detail 指定なら即返し */
    if (url.includes('/detail') && stopAt === 'details') {
      writeObj(await scrapeDetail(page, url));
      res.end(']');
      return;
    }

    /* 企業一覧取得 */
    const companies = await fetchCompanies(page);
    if (stopAt === 'companies') {
      companies.forEach(writeObj);
      res.end(']');
      return;
    }

    /* 対象企業選定 */
    const target = (() => {
      if (url.includes('/corporates') && !url.includes('/jobs')) return companies;
      if (url.includes('/jobs/') && !url.includes('/detail')) {
        const m = companies.find(c => c.companyJobsUrl === url);
        return m ? [m] : [];
      }
      return null;
    })();
    if (!target || !target.length) { res.end(']'); return; }

    /* 求人一覧取得 */
    const flatJobs = [];
    for (const { companyName, companyJobsUrl } of target) {
      const jobs = await fetchJobItems(page, companyJobsUrl);
      for (const j of jobs) {
        const row = { companyName, title: j.title, url: j.url };
        flatJobs.push(row);
        if (stopAt === 'jobs') writeObj(row);
      }
    }
    if (stopAt === 'jobs') { res.end(']'); return; }

    /* 詳細取得 */
    for (const j of flatJobs) {
      const dUrls = await fetchDetailUrls(page, j.url);
      for (const dUrl of dUrls) {
        const dInfo = await scrapeDetail(page, dUrl);
        writeObj({ ...j, ...dInfo });
      }
    }
    res.end(']');
  } catch (e) {
    console.error(e);
    res.write((first ? '' : ',') + JSON.stringify({ error: e.message }));
    res.end(']');
  } finally {
    if (context) await context.close();
  }
});

app.listen(PORT, () => console.log(`✅ Streaming on http://localhost:${PORT}`));
