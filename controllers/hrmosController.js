// hrmos.js  ★英語 UI 対応版 2025-06-25
const LOGIN_URL  = 'https://hrmos.co/agent/login';
const CORP_TOP   = 'https://hrmos.co/agent/corporates';
const LOCAL_WORDS = ['名古屋', '愛知', '北海道', '沖縄', '福岡', '広島'];

/* ========== 1. ログイン ========== */
async function login(browserState, secrets) {
    const { email, password } = secrets;
    if (!email || !password) throw new Error('email/password が指定されていません');

    const browser = await browserState.ensureBrowser();
    /* 👇 英語 UI でも日本語 UI でも動くよう locale + stealth */
    const context = await browser.newContext({
        locale: 'ja-JP',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    await page.goto(LOGIN_URL, { waitUntil: 'load' });
    await page.waitForSelector('input[name="email"]');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);

    await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForURL(CORP_TOP, { timeout: 30000 }),
    ]);

    await page.waitForLoadState('load');
    return { page, context };
}

/* ========== 2. DOM 安定待ち ========== */
async function waitForDOMStability(page, delayMs = 1500) {
    await page.evaluate(async (delay) => {
        return await new Promise((resolve) => {
            let timeout;
            const observer = new MutationObserver(() => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    observer.disconnect();
                    resolve();
                }, delay);
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }, delayMs);
}

/* ========== 3. 企業一覧取得 ========== */
async function fetchCompanies(page) {
    await page.goto(CORP_TOP, { waitUntil: 'load' });
    await waitForDOMStability(page);

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

/* ========== 4. 求人リスト取得 ========== */
async function fetchJobItems(page, companyJobsUrl) {
    await page.goto(companyJobsUrl, { waitUntil: 'load' });
    await waitForDOMStability(page);

    return await page.$$eval('a[href*="/jobs/"]', (els, LOCAL_WORDS) => {
        const items = [];
        for (const a of els) {
            const raw = (a.querySelector('.normal')?.innerText || a.textContent).trim();
            const t = raw.replace(/@\{[^}]+\}/g, '').split(/Invited/i)[0].trim();
            if (!t) continue;
            if (t.includes('組み込み') || LOCAL_WORDS.some(l => t.includes(l))) continue;
            items.push({ title: t, url: a.href });
        }
        const seen = new Set();
        return items.filter(i => {
            if (seen.has(i.url)) return false;
            seen.add(i.url);
            return true;
        });
    }, LOCAL_WORDS);
}

/* ========== 5. 詳細ページ URL 取得 ========== */
async function fetchDetailUrls(page, jobUrl) {
    await page.goto(jobUrl, { waitUntil: 'load' });
    await waitForDOMStability(page);

    return await page.$$eval('a[href*="/detail"]', els => Array.from(new Set(els.map(a => a.href))));
}

/* ========== 6. 詳細スクレイピング ========== */
async function scrapeDetail(page, detailUrl) {
    await page.goto(detailUrl, { waitUntil: 'load' });
    await waitForDOMStability(page);

    await Promise.all([
        page.waitForSelector('pre', { timeout: 15000 }),
    ]);
    await page.waitForSelector('h1,h2,dt,th', { timeout: 15000 });

    return await page.evaluate((detailUrl) => {
        /* ---------- 共通ユーティリティ ---------- */
        const getFormattedText = (el) => {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('img,picture,svg').forEach(n => n.remove());
            clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
            clone.querySelectorAll('li').forEach(li => li.insertAdjacentText('afterbegin', '• '));
            return clone.innerText.replace(/\r?\n/g, ' ').replace(/\\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
        };

        const extractByLabels = (labels, joinAll = false) => {
            const isMatch = txt => labels.some(l => txt && txt.trim().toLowerCase().includes(l.toLowerCase()));
            const results = [];

            for (const el of document.querySelectorAll('th,dt')) {
                if (isMatch(el.innerText)) {
                    const val = el.nextElementSibling || el.parentElement.querySelector('td,dd');
                    if (val) results.push(getFormattedText(val));
                }
            }
            for (const h of document.querySelectorAll('h1,h2,h3,strong,b')) {
                if (isMatch(h.innerText)) {
                    let n = h.nextElementSibling;
                    while (n && n.innerText.trim() === '') n = n.nextElementSibling;
                    if (n) results.push(getFormattedText(n));
                }
            }
            return joinAll ? results.join('\n') : (results[0] || '');
        };

        /* posting_details からのラベル補完 */
        const extractFromPostingDetails = (posting, label) => {
            const regex = new RegExp(`${label}\\s*[:：]?\\s*(.+)`, 'i');
            const match = posting.match(regex);
            return match ? match[1].trim() : '';
        };
            // ✅ バイト数に基づいてトリミングする関数をここに追加
        const truncateUTF8 = (str, maxBytes) => {
            let bytes = 0;
            let result = '';
            for (const char of str) {
                const code = char.codePointAt(0);
                bytes += code <= 0x7F ? 1 :
                        code <= 0x7FF ? 2 :
                        code <= 0xFFFF ? 3 : 4;
                if (bytes > maxBytes) break;
                result += char;
            }
            return result;
        };

        /* ---------- 大きなブロック抽出 ---------- */
        let postingDetails = '';
        const tbodies = Array.from(document.querySelectorAll('tbody')).map(tb => getFormattedText(tb)).filter(t => t.length);
        if (tbodies.length) postingDetails = tbodies.join('\n\n');
        else {
            const bodyBlocks = Array.from(document.querySelectorAll('section, div, article'))
                .filter(e => (e.innerText || '').length > 200);
            if (bodyBlocks.length) {
                postingDetails = getFormattedText(bodyBlocks.sort((a, b) => b.innerText.length - a.innerText.length)[0]);
            }
        }
        /* ---------- 汎用セクション抽出 ---------- */
        function pickSectionText(labelRegex) {
          // A. <th> or <dt> 形式  ------------------------------------
          for (const th of document.querySelectorAll('th,dt')) {
            if (labelRegex.test(th.innerText)) {
              const cell = th.nextElementSibling || th.parentElement.querySelector('td,dd,pre');
              if (cell) return getFormattedText(cell);
            }
          }

          // B. 見出し + ブロック形式  --------------------------------
          for (const h of document.querySelectorAll('h1,h2,h3,strong,b')) {
            if (labelRegex.test((h.innerText || '').trim())) {
              const parts = [];
              let cur = h.nextElementSibling;
              while (cur) {
                if (/^h[1-3]$/i.test(cur.tagName)) break;          // 次の見出しが来たら終了
                if ((cur.innerText || '').trim().length) parts.push(getFormattedText(cur));
                cur = cur.nextElementSibling;
              }
              if (parts.length) return parts.join('\n').trim();
            }
          }
          return ''; // 見つからなければ空
        }
        /* ---------- 特定ブロック抽出 ---------- */
        const recruitmentDetails = pickSectionText(/必須|MUST|Required/i);   // ← MUST 専用
        const idealProfile       = pickSectionText(/歓迎|WANT|Desired|Ideal/i); // ← WANT 専用

        /* ---------- UI 言語判定 ---------- */
        const isEnglishUI = /Employment Type|Annual income|Job Title|Location/i.test(postingDetails);

        /* ---------- ラベルに英語も追加 ---------- */
        const LABELS = {
            jobTitle:          ['求人タイトル', 'Job Title'],
            occupation:        ['職種', '募集ポジション', 'Job Function', 'Position'],
            contractType:      ['雇用形態', 'Employment Type'],
            contractPeriod:    ['契約期間', 'Contract Period'],
            workLocation:      ['勤務地', 'Location'],
            workSchedule:      ['勤務時間', 'Working hours'],
            salary:            ['給与', '想定年収', 'Salary', 'Annual income'],
        };

        /* ---------- 個別項目 ---------- */
        const salaryBlock = extractByLabels(LABELS.salary, true) ||
                            extractFromPostingDetails(postingDetails, isEnglishUI ? 'Salary' : '給与');
        const salaryFirst = salaryBlock.split(/\r?\n/)[0].trim();

        const workTimeBlock = extractByLabels(LABELS.workSchedule, true) ||
                              extractFromPostingDetails(postingDetails, isEnglishUI ? 'Working hours' : '勤務時間');

        const companyName = extractByLabels(['会社名', 'Company Name']) ||
                            extractFromPostingDetails(postingDetails, isEnglishUI ? 'Company Name' : '会社名');

        const workCondKeysJP  = ['固定時間制', '変動勤務時間制', 'フレックスタイム制', '裁量勤務制'];
        const workCondKeysEN  = ['Fixed', 'Shift', 'Flex', 'Discretionary'];
        const workCondKeys    = workCondKeysJP.concat(workCondKeysEN);
        const workingCondMatch = workCondKeys.find(k =>
            salaryBlock.includes(k) || workTimeBlock.includes(k)) || '';

        /* ---------- 結果オブジェクト ---------- */
        return {
            companyName,
            detailUrl,
            JPS_applied_job_title: truncateUTF8(extractByLabels(LABELS.jobTitle) || '', 79),
            JPS_occupation_category: extractByLabels(LABELS.occupation),
            JPS_position_department: '',
            JPS_overseas_residency_check: '',
            JPS_display_language: isEnglishUI ? 'English' : '日本語',
            JPS_contract_type: extractByLabels(LABELS.contractType),
            JPS_contract_period: extractByLabels(LABELS.contractPeriod),
            JPS_work_location: extractByLabels(LABELS.workLocation),
            JPS_salary: salaryFirst,
            JPS_working_conditions: workingCondMatch,
            JPS_work_schedule: workTimeBlock,
            JPS_trial_period: '',
            JPS_trial_period_others: '',
            JPS_recruitment_details: recruitmentDetails,
            JPS_ideal_candidate_profile: idealProfile,
            JPS_posting_details: postingDetails
        };
    }, detailUrl);
}

/* ========== 7. 全体ハンドラ ========== */
async function processScrape({ page, res, url, stopAt }) {
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
        if (url.includes('/detail') && stopAt === 'details') {
            writeObj(await scrapeDetail(page, url));
            res.end(']');
            return;
        }

        const companies = await fetchCompanies(page);
        if (stopAt === 'companies') {
            companies.forEach(writeObj);
            res.end(']');
            return;
        }

        const target = (() => {
            if (url.includes('/corporates') && !url.includes('/jobs')) return companies;
            if (url.includes('/jobs/') && !url.includes('/detail')) {
                const match = companies.find(c => c.companyJobsUrl === url);
                return match ? [match] : [];
            }
            return null;
        })();

        if (!target || !target.length) {
            res.end(']');
            return;
        }

        const flatJobs = [];
        for (const { companyName, companyJobsUrl } of target) {
            const jobs = await fetchJobItems(page, companyJobsUrl);
            for (const j of jobs) {
                const row = { companyName, title: j.title, url: j.url };
                flatJobs.push(row);
                if (stopAt === 'jobs') writeObj(row);
            }
        }

        if (stopAt === 'jobs') {
            res.end(']');
            return;
        }

        for (const j of flatJobs) {
            const dUrls = await fetchDetailUrls(page, j.url);
            for (const dUrl of dUrls) {
                const dInfo = await scrapeDetail(page, dUrl);
                const { companyName: _, ...rest } = dInfo;
                writeObj({ ...j, ...rest });
            }
        }
        res.end(']');
    } catch (err) {
        console.error(err);
        res.write((first ? '' : ',') + JSON.stringify({ error: err.message }));
        res.end(']');
    } finally {
        if (page.context()) await page.context().close();
    }
}

/* ========== 8. エクスポート ========== */
module.exports = {
    login,
    fetchCompanies,
    fetchJobItems,
    fetchDetailUrls,
    scrapeDetail,
    processScrape,
    waitForDOMStability
};
