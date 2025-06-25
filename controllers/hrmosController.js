const LOGIN_URL = 'https://hrmos.co/agent/login';
const CORP_TOP = 'https://hrmos.co/agent/corporates';
const LOCAL_WORDS = ['名古屋', '愛知', '北海道', '沖縄', '福岡', '広島'];

async function login(browserState, secrets) {
    const { email, password } = secrets;
    if (!email || !password) throw new Error('email/passwordが指定されていません');

    const browser = await browserState.ensureBrowser();
    const context = await browser.newContext();
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

async function waitForDOMStability(page, delayMs = 1200) {
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

async function fetchDetailUrls(page, jobUrl) {
    await page.goto(jobUrl, { waitUntil: 'load' });
    await waitForDOMStability(page);

    return await page.$$eval('a[href*="/detail"]', els => Array.from(new Set(els.map(a => a.href))));
}

async function scrapeDetail(page, detailUrl) {
    await page.goto(detailUrl, { waitUntil: 'load' });
    await waitForDOMStability(page);

    // 追加：pre や img が描画されるまで待つ
    await Promise.all([
        page.waitForSelector('pre', { timeout: 15000 }),
    ]);

    await page.waitForSelector('h1,h2,dt', { timeout: 15000 });

    return await page.evaluate((detailUrl) => {
        function getFormattedText(el) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('img,picture,svg').forEach(n => n.remove());
            clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
            clone.querySelectorAll('li').forEach(li => li.insertAdjacentText('afterbegin', '• '));
            return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
        }

        function extractByLabels(labels, joinAll = false) {
            const isMatch = txt => labels.some(l => txt && txt.trim().includes(l));
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
        }

        let postingDetails = '';
        const tbodies = Array.from(document.querySelectorAll('tbody')).map(tb => getFormattedText(tb)).filter(t => t.length);
        if (tbodies.length) postingDetails = tbodies.join('\n\n');
        else {
            const bodyBlocks = Array.from(document.querySelectorAll('section, div, article')).filter(e => (e.innerText || '').length > 200);
            if (bodyBlocks.length) postingDetails = getFormattedText(bodyBlocks.sort((a, b) => b.innerText.length - a.innerText.length)[0]);
        }

        let recruitmentDetails = '';
        const heading = Array.from(document.querySelectorAll('h1,h2,h3,strong,b')).find(h => /応募資格/.test(h.innerText));
        if (heading) {
            const parts = [];
            const stopTags = new Set(['H1', 'H2', 'H3', 'STRONG', 'B']);
            let n = heading.nextElementSibling;
            while (n && !stopTags.has(n.tagName)) {
                if ((n.innerText || '').trim()) parts.push(getFormattedText(n));
                n = n.nextElementSibling;
            }
            recruitmentDetails = parts.join('\n');
        }

        const companyName = extractByLabels(['会社名']);
        const salaryBlock = extractByLabels(['給与', '想定年収'], true);
        const salaryFirst = salaryBlock.split(/\r?\n/)[0].trim();
        const workTimeBlock = extractByLabels(['勤務時間', '勤務時間・曜日'], true);
        const workCondKeys = ['固定時間制', '変動勤務時間制', 'フレックスタイム制', '裁量勤務制'];
        const workingCondMatch = workCondKeys.find(k => salaryBlock.includes(k) || workTimeBlock.includes(k)) || '';
        const idealProfile = extractByLabels(['求める人物像', '歓迎する経歴', '応募資格（WANT）'], true);

        return {
            companyName,
            detailUrl,
            JPS_applied_job_title: extractByLabels(['求人タイトル']),
            JPS_occupation_category: extractByLabels(['職種', '募集ポジション']),
            JPS_position_department: '',
            JPS_overseas_residency_check: '',
            JPS_display_language: '日本語',
            JPS_contract_type: extractByLabels(['雇用形態']),
            JPS_work_location: extractByLabels(['勤務地']),
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

async function processScrape({ page, res, url, stopAt }) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Transfer-Encoding': 'chunked' });
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

module.exports = {
    login,
    fetchCompanies,
    fetchJobItems,
    fetchDetailUrls,
    scrapeDetail,
    processScrape,
    waitForDOMStability
};
