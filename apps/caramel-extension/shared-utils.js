/********************************************************************
 * Caramel core logic – 2025-06-29  (speed-tuned)
 ********************************************************************/

/* --------------------------------------------------  bootstrap */
const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome;
    if (typeof browser !== 'undefined') return browser;
    throw new Error('Browser is not supported!');
})();

/* --------------------------------------------------  tiny helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('Caramel:', ...a);

/* --------------------------------------------------  adaptive timing system */
const sitePerformance = new Map(); // Track site response times
const getAdaptiveTimeout = (domain, baseTimeout = 1500) => {
    const perf = sitePerformance.get(domain);
    if (!perf) return baseTimeout;
    // If site is consistently fast, use shorter timeout
    if (perf.avgResponseTime < 800) return Math.max(800, baseTimeout * 0.6);
    // If site is slow, use longer timeout
    if (perf.avgResponseTime > 2000) return Math.min(4000, baseTimeout * 1.5);
    return baseTimeout;
};

const recordResponseTime = (domain, responseTime) => {
    const perf = sitePerformance.get(domain) || { avgResponseTime: 1500, count: 0 };
    perf.avgResponseTime = (perf.avgResponseTime * perf.count + responseTime) / (perf.count + 1);
    perf.count++;
    sitePerformance.set(domain, perf);
};

/* ---------- DOM waiters ---------- */
function waitForElement(sel, timeout = 4000, domain = null) {
    const adaptiveTimeout = domain ? getAdaptiveTimeout(domain, timeout) : timeout;
    return new Promise((res, rej) => {
        if (document.querySelector(sel)) return res('found-immediately');
        const startTime = performance.now();
        const mo = new MutationObserver(() => {
            if (document.querySelector(sel)) {
                mo.disconnect();
                const responseTime = performance.now() - startTime;
                if (domain) recordResponseTime(domain, responseTime);
                res('appeared');
            }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
            mo.disconnect();
            rej(`waitForElement timeout (${sel})`);
        }, adaptiveTimeout);
    });
}
function waitForTextChange(el, timeout = 3000, domain = null) {
    const adaptiveTimeout = domain ? getAdaptiveTimeout(domain, timeout) : timeout;
    return new Promise((res, rej) => {
        const start = el.textContent;
        const startTime = performance.now();
        const mo = new MutationObserver(() => {
            if (el.textContent !== start) {
                mo.disconnect();
                const responseTime = performance.now() - startTime;
                if (domain) recordResponseTime(domain, responseTime);
                res('text-changed');
            }
        });
        mo.observe(el, { characterData: true, childList: true, subtree: true });
        setTimeout(() => {
            mo.disconnect();
            rej('waitForTextChange timeout');
        }, adaptiveTimeout);
    });
}
function waitForAmazonFetch() {
    return new Promise((resolve) => {
        const orig = window.fetch;
        window.fetch = (...args) => {
            const [url] = args;
            const p = orig(...args);
            if (url.includes('/apply-discount')) {
                p.finally(() => {
                    window.fetch = orig;
                    resolve('network-reply');
                });
            }
            return p;
        };
    });
}

/* ---------- UI readiness helper (new) ---------- */
async function waitUntilReady(rec, timeout = 2000, domain = null) {
    const adaptiveTimeout = domain ? getAdaptiveTimeout(domain, timeout) : timeout;
    const btn = document.querySelector(rec.couponSubmit);
    const start = performance.now();
    return new Promise((resolve) => {
        (function loop() {
            if (!btn || !btn.disabled) return resolve();
            if (performance.now() - start > adaptiveTimeout) return resolve(); // hard fallback
            requestAnimationFrame(loop);
        })();
    });
}

/* --------------------------------------------------  price grabber */
function getPrice(selector, { returnLargest } = {}) {
    let el = document.querySelector(selector);
    if (!el && selector.includes('[id=')) {
        const id = selector.match(/\[id=['"]([^'"]+)['"]\]/)?.[1];
        if (id) el = document.getElementById(id);
    }
    if (!el) {
        log('getPrice: element NOT found', selector);
        return NaN;
    }

    const regex = /(?:[A-Z]{1,3}\s?)?[$£€]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;
    const prices = (el.innerText.match(regex) || []).map((t) =>
        parseFloat(t.replace(/[^0-9.]/g, ''))
    );
    if (!prices.length) {
        log('getPrice: no price found');
        return NaN;
    }
    return returnLargest ? Math.max(...prices) : prices[0];
}

/* --------------------------------------------------  config cache */
async function getDomainRecord(domain) {
    if (!getDomainRecord.cache) {
        const r = await fetch(currentBrowser.runtime.getURL('supported.json'));
        const dat = await r.json();
        getDomainRecord.cache = Array.isArray(dat.supported) ? dat.supported : dat;
        log('Loaded supported domains');
    }
    return getDomainRecord.cache.find((r) => domain.includes(r.domain));
}
getDomainRecord.cache = null;

/* --------------------------------------------------  checkout detector */
async function isCheckout() {
    const rec = await getDomainRecord(location.hostname);
    if (!rec) return false;
    if (document.querySelector(rec.couponInput) || document.querySelector(rec.showInput))
        return true;
    try {
        await waitForElement(`${rec.couponInput},${rec.showInput}`, 3000);
    } catch (e) {
        log(e);
    }
    return !!(document.querySelector(rec.couponInput) || document.querySelector(rec.showInput));
}

/* --------------------------------------------------  init hook */
async function tryInitialize() {
    if (await isCheckout()) {
        const rec = await getDomainRecord(location.hostname);
        await insertCaramelPrompt(rec);
    }
}

/* --------------------------------------------------  coupon attempt */
async function applyCoupon(code, rec) {
    log('► Trying', code);
    const domain = rec.domain || location.hostname;
    const startTime = performance.now();

    try {
        /* 1] dismiss popup if present */
        if (rec.dismissButton) {
            const btn = document.querySelector(rec.dismissButton);
            if (btn) {
                btn.click();
                await sleep(180);
                log('Popup dismissed');
            }
        }

        /* 2] ensure input visible */
        let input = document.querySelector(rec.couponInput);
        if (!input && rec.showInput) {
            const showBtn = document.querySelector(rec.showInput);
            if (showBtn) {
                showBtn.click();
                try {
                    await waitForElement(rec.couponInput, 3000, domain);
                } catch (e) {
                    log(e);
                }
                input = document.querySelector(rec.couponInput);
            }
        }
        const applyBtn = document.querySelector(rec.couponSubmit);
        if (!input || !applyBtn) {
            log('Input / apply button missing');
            return { success: false };
        }

        const original = getPrice(rec.priceContainer, { returnLargest: true });

        /* 3] fill & click */
        input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        applyBtn.click();

        /* 4] smart wait with early success detection */
        const adaptiveTimeout = getAdaptiveTimeout(domain, 3500);
        const waiters = [sleep(adaptiveTimeout).then(() => 'timeout')];

        const priceEl =
            document.querySelector(rec.priceContainer) ||
            document.getElementById(rec.priceContainer.match(/\[id=['"]([^'"]+)['"]\]/)?.[1] || '');

        if (priceEl && rec.domain !== 'amazon.com') {
            waiters.push(waitForTextChange(priceEl, 3000, domain));
        }
        if (rec.domain === 'amazon.com') {
            waiters.push(waitForAmazonFetch());
        }

        // Early success detection - check for immediate price change
        const earlyCheck = setInterval(() => {
            const currentPrice = getPrice(rec.priceContainer, { returnLargest: true });
            if (!isNaN(currentPrice) && currentPrice < original) {
                clearInterval(earlyCheck);
                // Resolve the promise early
                const responseTime = performance.now() - startTime;
                recordResponseTime(domain, responseTime);
                log('Early success detected!');
            }
        }, 200);

        const via = await Promise.race(waiters);
        clearInterval(earlyCheck);

        const responseTime = performance.now() - startTime;
        recordResponseTime(domain, responseTime);
        log('Wait finished via', via, `(${Math.round(responseTime)}ms)`);

        const newTotal = getPrice(rec.priceContainer, { returnLargest: true });
        return { success: !isNaN(newTotal) && newTotal < original, newTotal };
    } catch (err) {
        console.error('applyCoupon error', err);
        return { success: false };
    }
}

/* --------------------------------------------------  coupon list */
async function fetchCoupons(site, kw) {
    const url = `https://grabcaramel.com/api/coupons?site=${site}&key_words=${encodeURIComponent(kw)}&limit=20`;
    try {
        const r = await fetch(url);
        const d = r.ok ? await r.json() : [];
        log('Fetched', d.length, 'coupons');
        return d;
    } catch (e) {
        log('fetchCoupons error', e);
        return [];
    }
}
async function getCoupons(rec) {
    let kw = '';
    if (rec.domain === 'amazon.com') {
        const resp = await new Promise((res) =>
            currentBrowser.runtime.sendMessage({ action: 'scrapeAmazonCartKeywords' }, res)
        );
        kw = (resp?.keywords || []).join(',');
        log('Amazon keywords', kw);
    }
    return fetchCoupons(rec.domain, kw);
}

/* --------------------------------------------------  main runner */
async function startApplyingCoupons(rec) {
    log('=== Starting coupon flow ===');
    await showTestingModal();

    const coupons = await getCoupons(rec);
    if (!coupons.length) {
        showFinalModal(0, null, 'No coupons found.');
        return;
    }

    const original = getPrice(rec.priceContainer, { returnLargest: true });
    let bestSave = 0,
        bestCode = null;

    for (let i = 0; i < coupons.length; i++) {
        const { code } = coupons[i];
        await updateTestingModal(i + 1, coupons.length, code);

        const res = await applyCoupon(code, rec);

        /* clear field & wait until UI ready for next pass */
        const inp = document.querySelector(rec.couponInput);
        if (inp) {
            inp.value = '';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Use adaptive timing based on site performance
        const domain = rec.domain || location.hostname;
        const adaptiveWait = getAdaptiveTimeout(domain, 2000);
        await waitUntilReady(rec, adaptiveWait, domain);

        // Shorter pause for fast sites, longer for slow ones
        const pauseTime = getAdaptiveTimeout(domain, 120) < 200 ? 60 : 120;
        await sleep(pauseTime);

        if (res.success) {
            const diff = original - res.newTotal;
            log(`✓ ${code} saved ${diff}`);
            if (diff > bestSave) {
                bestSave = diff;
                bestCode = code;
            }
        } else {
            log(`✗ ${code} no savings`);
        }
    }

    if (bestCode) {
        await applyCoupon(bestCode, rec);
        showFinalModal(bestSave, bestCode, 'We found a coupon that saves you money!');
    } else {
        showFinalModal(0, null, 'Already the best price.');
    }
}

/* --------------------------------------------------  listeners (unchanged) */
window.addEventListener('message', (ev) => {
    if (ev.origin !== 'https://grabcaramel.com') return;
    if (ev.data?.token) {
        currentBrowser.storage.sync.set(
            {
                token: ev.data.token,
                user: {
                    username: ev.data.username || 'CaramelUser',
                    image: ev.data.image,
                },
            },
            tryInitialize
        );
    }
});
currentBrowser.runtime.onMessage.addListener(async (req, _s, send) => {
    if (req.action === 'userLoggedIn') {
        const rec = await getDomainRecord(location.hostname);
        await startApplyingCoupons(rec);
        send({ success: true });
    }
});
