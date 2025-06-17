const express    = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

const PORT        = process.env.PORT || 3000;
const LOGIN_URL   = 'https://hrmos.co/agent/login';
const CORP_TOP    = 'https://hrmos.co/agent/corporates';
const LOCAL_WORDS = ['名古屋','北海道','沖縄','福岡','広島'];

/* ─────── Playwright シングルトン ─────── */
let browser, context, page;
async function ensurePlaywright () {
  if (!browser)  browser  = await chromium.launch({ headless: true });
  if (!context)  context  = await browser.newContext();
  if (!page)     page     = await context.newPage();
}

/* ─────── ログイン ─────── */
async function login(email, password) {
  await ensurePlaywright();
-  await page.goto(LOGIN_URL, { waitUntil: 'load' });
+  // networkidle にして、XHR/CSS/JS の読み込み完了も待つ
+  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
+  // ここでフォームが必ず表示されるまで待つ
+  await page.waitForSelector('input[name="email"]', { timeout: 30000 });

  await page.fill('input[name="email"]',    email);
  await page.fill('input[name="password"]', password);

  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForURL(CORP_TOP, { timeout: 15000 })
  ]);
}

/* ─────── 企業求人ページ URL & 名前 ─────── */
async function fetchCompanies() {
  await page.goto(CORP_TOP, { waitUntil:'networkidle' });
  return await page.$$eval('a[href*="/jobs"]', els => {
    const seen = new Set();
    return els.map(a=>{
      if(seen.has(a.href)) return null;
      seen.add(a.href);
      return { companyName: a.textContent.trim(), companyUrl: a.href };
    }).filter(Boolean);
  });
}

/* ─────── 求人 URL 一覧（除外フィルタ付） ─────── */
async function fetchJobUrls(companyUrl) {
  await page.goto(companyUrl, { waitUntil:'networkidle' });
  const jobs = await page.$$eval('a[href*="/jobs/"]', els =>
    els.map(a => ({ url:a.href, title:a.textContent.trim() }))
  );
  return jobs
    .filter(j => !( j.title.includes('組み込み') &&
                    LOCAL_WORDS.some(w => j.title.includes(w)) ))
    .map(j => j.url);
}

/* ─────── 詳細 URL 一覧 ─────── */
async function fetchDetailUrls(jobUrl) {
  await page.goto(jobUrl, { waitUntil:'networkidle' });
  return await page.$$eval('a[href*="/detail"]',
          els => [...new Set(els.map(a=>a.href))]);
}

/* ─────── 詳細ページ構造化（画像は取らない） ─────── */
async function scrapeDetail(detailUrl) {
  await page.goto(detailUrl, { waitUntil:'networkidle' });
  await page.waitForSelector('article,h1',{timeout:8000});

  return await page.evaluate(detailUrl => {
    const label = (...texts)=> {
      const nodes=[...document.querySelectorAll('h2,th')];
      for(const n of nodes){
        if(texts.some(t=>n.innerText.includes(t))){
          const td=n.closest('tr')?.querySelector('td');
          if(td) return td.innerText.trim();
          const sib=n.nextElementSibling;
          if(sib) return sib.innerText.trim();
        }
      }
      return '';
    };

    const body = document.querySelector('article')?.innerText || '';
    const num  = s => s.replace(/[^0-9]/g,'');

    return {
      detailUrl,
      JPS_applied_job_title          : document.querySelector('h1')?.innerText.trim() || '',
      JPS_occupation_category        : label('職種','カテゴリー'),
      JPS_position_department        : label('部署','部門'),
      JPS_position_priority          : label('優先度','プライオリティ'),
      JPS_posting_details            : body,
      JPS_revenue                    : label('売上','収益'),
      JPS_overseas_residency_check   : label('海外在住'),
      JPS_OPPreferral_fee_percentage : label('紹介料'),
      JPS_display_language           : label('表示言語','Language'),
      JPS_contract_type              : label('雇用形態'),
      JPS_work_location              : label('勤務地'),
      JPS_salary                     : num(label('給与')),
      JPS_working_conditions         : label('勤務形態'),
      JPS_work_schedule              : label('勤務時間','勤務曜日'),
      JPS_trial_period               : label('試用期間'),
      JPS_trial_period_others        : label('試用期間その他'),
      JPS_recruitment_details        : label('募集要項') || body,
      JPS_ideal_candidate_profile    : label('求める人物像')
    };
  }, detailUrl);
}

/* ─────── Express ─────── */
const app = express();
app.use(bodyParser.json());

app.post('/scrape', async (req, res) => {
  const {
    site='hrmos', email, password, url,
    stopAt='details'           // companies | jobs | details
  } = req.body;

  if(site!=='hrmos') return res.status(400).json({ error:'site must be hrmos' });
  if(!email||!password||!url)  return res.status(400).json({ error:'email, password, url are required' });
  if(!['companies','jobs','details'].includes(stopAt))
    return res.status(400).json({ error:'stopAt must be companies | jobs | details' });

  try{
    await login(email,password);
    const out=[];

    const isDetail=url.includes('/detail');
    const isJob   =url.includes('/jobs/') && !isDetail;
    const isComp  =url.includes('/jobs')  && !isJob && !isDetail;

    /* detail 指定 */
    if(isDetail){
      if(stopAt==='companies') return res.json({ out:[] });
      if(stopAt==='jobs')      return res.json({ out:[url] });
      out.push(await scrapeDetail(url));
      return res.json({ status:'success', out });
    }

    /* job 指定 */
    if(isJob){
      const dUrls = await fetchDetailUrls(url);
      if(stopAt==='jobs') return res.json({ status:'success', out:dUrls });
      for(const d of dUrls) out.push(await scrapeDetail(d));
      return res.json({ status:'success', out });
    }

    /* company 指定 */
    if(isComp){
      const jobUrls = await fetchJobUrls(url);
      if(stopAt==='jobs') return res.json({ status:'success', out:jobUrls });
      for(const j of jobUrls){
        const dUrls = await fetchDetailUrls(j);
        for(const d of dUrls) out.push(await scrapeDetail(d));
      }
      return res.json({ status:'success', out });
    }

    /* /corporates 起点 */
    const companies = await fetchCompanies();
    if(stopAt==='companies') return res.json({ status:'success', out:companies });

    for(const {companyUrl} of companies){
      const jobUrls = await fetchJobUrls(companyUrl);
      if(stopAt==='jobs'){ out.push({companyUrl, jobUrls}); continue; }
      for(const j of jobUrls){
        const dUrls = await fetchDetailUrls(j);
        for(const d of dUrls) out.push(await scrapeDetail(d));
      }
    }
    return res.json({ status:'success', out });

  }catch(e){
    console.error(e);
    res.status(500).json({ status:'error', message:e.message });
  }
});

/* ─────── Server start ─────── */
app.listen(PORT,()=>console.log(`✅ HRMOS Scraper listening on http://localhost:${PORT}`));