const PAGE_VIDEO_DETAIL_REQUEST = "RESOLVE_PAGE_VIDEO_DETAIL_REQ";
const PAGE_VIDEO_DETAIL_RESPONSE = "RESOLVE_PAGE_VIDEO_DETAIL_RESP";
const MAX_IFRAME_CONCURRENCY = 1;
const MAX_IFRAME_QUEUE_SIZE = 4;
const IFRAME_QUEUE_TIMEOUT_MS = 20000;
const IFRAME_RESOLVE_TIMEOUT_MS = 15000;
// 抖音及其关联 CDN 的可信视频域名列表，用于快速判定候选播放地址。
const ALLOWED_VIDEO_HOST_SUFFIXES = [
    "douyinvod.com",
    "snssdk.com",
    "douyinpic.com",
    "amemv.com",
    "douyinstatic.com",
    "iesdouyin.com",
    "ixigua.com",
    "toutiao.com"
];
const REACT_SCAN_INTERVAL_MS = 50;
const REACT_SCAN_MAX_VISITED = 6000;
const REACT_SCAN_MAX_QUEUED = 12000;
const REACT_SCAN_MAX_DEPTH = 12;

// Inspector ("检察官"): safety guard that validates inputs and wraps each step
// so a single failing call never crashes the whole resolution pipeline.
function inspector(label, fn, fallback = null) {
    try {
        const result = fn();
        if (result && typeof result.then === "function") {
            return result.catch(error => {
                console.log("[douyin-downloader] inspector caught async error", {
                    label,
                    error: String((error && error.message) || error)
                });
                return fallback;
            });
        }
        return result;
    } catch (error) {
        console.log("[douyin-downloader] inspector caught error", {
            label,
            error: String((error && error.message) || error)
        });
        return fallback;
    }
}

function isValidVid(vid) {
    return /^\d{6,}$/.test(String(vid == null ? "" : vid).trim());
}

const REACT_SCAN_SKIPPED_KEYS = new Set([
    "ownerDocument",
    "parentNode",
    "previousSibling",
    "nextSibling",
    "firstChild",
    "lastChild",
    "document",
    "defaultView",
    "window",
    "self",
    "globalThis",
    "return",
    "alternate",
    "_debugOwner",
    "stateNode"
]);

let activeIframeCount = 0;
const iframeQueue = [];
const iframeTasks = new Map();

function resolutionNumber(gearName, width, height) {
    if (gearName.includes("4_")) return 2160;
    const match = gearName.match(/(\d{3,4})/);
    return match ? Number(match[1]) : Math.min(width, height);
}

function resolutionLabel(value) {
    if (value === 2160) return "4K";
    if (value === 1440) return "2K";
    return `${value}P`;
}

function getUrls(bitRate) {
    const playAddr = bitRate.playAddr || bitRate.play_addr;
    if (Array.isArray(playAddr)) {
        return playAddr.map(item => item?.src || item?.url).filter(Boolean);
    }
    return (playAddr?.urlList || playAddr?.url_list || []).filter(Boolean);
}

function toVideoDetail(awemeInfo, expectedVid) {
    const vid = String(awemeInfo?.awemeId || awemeInfo?.aweme_id || "");
    const video = awemeInfo?.video;
    const sourceBitRates = video?.bitRateList || video?.bit_rate;
    if (vid !== String(expectedVid) || !Array.isArray(sourceBitRates)) return null;

    const bitRateList = sourceBitRates.flatMap(bitRate => {
        const urls = getUrls(bitRate).filter(url => {
            try {
                return new URL(url).protocol === "https:";
            } catch {
                return false;
            }
        });
        const format = String(bitRate.videoFormat || bitRate.format || "").toLowerCase();
        const isMp4 = format ? format === "mp4" : urls.some(url => url.includes("mime_type=video_mp4"));
        if (!isMp4 || urls.length === 0) return [];

        const playAddr = bitRate.playAddr || bitRate.play_addr || {};
        const width = Number(bitRate.width || playAddr.width || 0);
        const height = Number(bitRate.height || playAddr.height || 0);
        const gearName = String(bitRate.gearName || bitRate.gear_name || "");
        const resolution = resolutionNumber(gearName, width, height);
        return [{
            bitRate: Number(bitRate.bitRate || bitRate.bit_rate || 0),
            dataSize: Number(bitRate.dataSize || playAddr.dataSize || playAddr.data_size || 0),
            width,
            height,
            format: "mp4",
            resolutionString: resolutionLabel(resolution),
            resolutionNumber: resolution,
            urlList: urls
        }];
    });
    if (bitRateList.length === 0) return null;

    const textExtra = awemeInfo.textExtra || awemeInfo.text_extra || [];
    let creator = awemeInfo.authorInfo?.nickname || awemeInfo.author?.nickname || "";
    let description = awemeInfo.desc || "";
    // DOM fallback: if React tree doesn't have creator/desc, read from page
    // using the logic selected in the settings (primary / backup).
    if (!creator) {
      creator = inspector("dom-fallback-creator", () => readCreatorFromDom(), "") || "";
    }
    if (!description) {
      description = inspector("dom-fallback-description", () => readDescriptionFromDom(), "") || "";
      description = description.replace(/\s*展开$/, "").trim();
    }
    return {
        vid,
        creator,
        description,
        tagList: textExtra
            .map(item => item?.hashtagName || item?.hashtag_name)
            .filter(Boolean)
            .map(tag => `#${tag}`),
        bitRateList
    };
}

function getFiberNode(el) {
    if (!el || typeof el !== "object") return null;
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
    return key ? el[key] : null;
}

function findAwemeInfo(root, vid) {
    const startNode = (root && typeof root === "object" && root.nodeType) ? (getFiberNode(root) || root) : root;
    const queue = [{value: startNode, depth: 0}];
    const visited = new WeakSet();
    let visitedCount = 0;
    let queueIndex = 0;

    while (queueIndex < queue.length && visitedCount < REACT_SCAN_MAX_VISITED) {
        const entry = queue[queueIndex];
        queue[queueIndex] = null;
        queueIndex += 1;
        if (!entry) continue;
        const {value, depth} = entry;
        if (!value || typeof value !== "object") continue;
        if (visited.has(value)) continue;
        visited.add(value);
        visitedCount += 1;

        if (toVideoDetail(value, vid)) return value;
        if (depth >= REACT_SCAN_MAX_DEPTH) continue;

        let keys;
        try {
            keys = Object.keys(value);
        } catch {
            continue;
        }
        for (const key of keys) {
            if (REACT_SCAN_SKIPPED_KEYS.has(key)) continue;
            if (queue.length >= REACT_SCAN_MAX_QUEUED) break;
            try {
                const child = value[key];
                if (child && typeof child === "object") {
                    queue.push({value: child, depth: depth + 1});
                }
            } catch {
                // React may expose lazy getters that throw outside its render cycle.
            }
        }
    }
    return null;
}

function isAllowedVideoCandidateUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        const host = parsed.hostname;
        return ALLOWED_VIDEO_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith("." + suffix))
            || (host === "www.douyin.com" && parsed.pathname.startsWith("/aweme/v1/play/"));
    } catch {
        return false;
    }
}

function hasAllowedVideoCandidates(detail) {
    if (!detail?.bitRateList) return false;
    return detail.bitRateList.some(b => b.urlList.some(isAllowedVideoCandidateUrl));
}

function resolveDetailFromIframeNow(vid) {
    if (window.self !== window.top) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const startedAt = Date.now();
        const iframe = document.createElement("iframe");
        iframe.setAttribute("aria-hidden", "true");
        iframe.setAttribute("allow", "autoplay 'none'; fullscreen 'none'");
        iframe.tabIndex = -1;
        iframe.style.cssText = "width:400px;height:300px;position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;border:none;";
        iframe.src = `https://www.douyin.com/video/${encodeURIComponent(vid)}`;

        let cleaned = false;
        let settled = false;
        let scanTimer = null;
        let deadlineTimer = null;
        let loggedContainerDiscovery = false;

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (scanTimer !== null) clearTimeout(scanTimer);
            if (deadlineTimer !== null) clearTimeout(deadlineTimer);
            try {
                const videos = iframe.contentWindow?.document?.querySelectorAll("video") || [];
                videos.forEach(video => {
                    video.pause();
                    video.removeAttribute("src");
                    video.load();
                });
                iframe.src = "about:blank";
            } catch {
                // The frame may already be navigating or detached.
            }
            iframe.remove();
        };

        const finish = (detail, reason) => {
            if (settled) return;
            settled = true;
            cleanup();
            console.log("[douyin-downloader] detail iframe resolution finished", {
                vid,
                reason,
                durationMs: Date.now() - startedAt,
                found: Boolean(detail),
                candidateCount: detail?.bitRateList?.length || 0
            });
            resolve(detail);
        };

        iframe.addEventListener("error", () => finish(null, "load-error"), { once: true });

        // Adaptive scan: start fast (50ms) so a ready page is detected almost
        // instantly; if not found within the fast window, slow to 200ms to avoid
        // pinning the main thread with repeated deep Fiber traversals.
        const FAST_SCAN_MS = 50;
        const SLOW_SCAN_MS = 200;
        const FAST_WINDOW_MS = 2000;
        const scan = () => {
            try {
                const doc = iframe.contentWindow?.document;
                if (doc) {
                    const videos = doc.querySelectorAll("video");
                    videos.forEach(v => {
                        v.muted = true;
                        v.pause();
                        v.preload = "none";
                    });

                    // Never traverse the hidden detail page's #root Fiber tree. It can
                    // retain and revisit most of the React application graph, which has
                    // caused the foreground Douyin renderer to crash under fallback use.
                    const containers = Array.from(doc.querySelectorAll(".basePlayerContainer"));
                    if (!loggedContainerDiscovery) {
                        loggedContainerDiscovery = true;
                        console.log("[douyin-downloader] detail iframe player containers discovered", {
                            vid,
                            containerCount: containers.length,
                            rootFiberScanDisabled: true
                        });
                    }
                    for (const container of containers) {
                        const awemeInfo = findAwemeInfo(container, vid);
                        const detail = awemeInfo && toVideoDetail(awemeInfo, vid);
                        if (detail && hasAllowedVideoCandidates(detail)) {
                            finish(detail, "resolved");
                            return;
                        }
                    }
                }
            } catch (error) {
                console.log("[douyin-downloader] detail iframe scan failed", { vid, error });
                finish(null, "scan-error");
                return;
            }
            if (!settled && !cleaned) {
                const elapsed = Date.now() - startedAt;
                const delay = elapsed < FAST_WINDOW_MS ? FAST_SCAN_MS : SLOW_SCAN_MS;
                scanTimer = setTimeout(scan, delay);
            }
        };
        scanTimer = setTimeout(scan, FAST_SCAN_MS);

        deadlineTimer = setTimeout(() => finish(null, "timeout"), IFRAME_RESOLVE_TIMEOUT_MS);

        if (!document.body) {
            finish(null, "missing-body");
            return;
        }
        try {
            document.body.appendChild(iframe);
        } catch (error) {
            console.log("[douyin-downloader] unable to append detail iframe", { vid, error });
            finish(null, "append-error");
        }
    });
}

function settleQueuedIframeTask(task, detail) {
    if (task.settled) return;
    task.settled = true;
    if (task.queueTimer !== null) clearTimeout(task.queueTimer);
    task.resolve(detail);
}

function runNextIframeTask() {
    while (activeIframeCount < MAX_IFRAME_CONCURRENCY && iframeQueue.length > 0) {
        const task = iframeQueue.shift();
        if (!task || task.settled) continue;

        if (task.queueTimer !== null) {
            clearTimeout(task.queueTimer);
            task.queueTimer = null;
        }
        activeIframeCount += 1;
        const startedAt = Date.now();
        console.log("[douyin-downloader] detail iframe task started", {
            vid: task.vid,
            activeCount: activeIframeCount,
            queueSize: iframeQueue.length,
            queuedForMs: startedAt - task.queuedAt
        });

        Promise.resolve(resolveDetailFromIframeNow(task.vid))
            .then(detail => {
                console.log("[douyin-downloader] detail iframe task resolved", {
                    vid: task.vid,
                    durationMs: Date.now() - startedAt,
                    found: Boolean(detail),
                    candidateCount: detail?.bitRateList?.length || 0
                });
                settleQueuedIframeTask(task, detail);
            })
            .catch(error => {
                console.log("[douyin-downloader] detail iframe task failed", {
                    vid: task.vid,
                    durationMs: Date.now() - startedAt,
                    error
                });
                settleQueuedIframeTask(task, null);
            })
            .finally(() => {
                activeIframeCount -= 1;
                console.log("[douyin-downloader] detail iframe task finished", {
                    vid: task.vid,
                    activeCount: activeIframeCount,
                    queueSize: iframeQueue.length
                });
                runNextIframeTask();
            });
    }
}

function resolveDetailFromIframe(vid) {
    const taskKey = String(vid);
    const existingTask = iframeTasks.get(taskKey);
    if (existingTask) {
        console.log("[douyin-downloader] reusing detail iframe task", {
            vid: taskKey,
            activeCount: activeIframeCount,
            queueSize: iframeQueue.length
        });
        return existingTask;
    }

    if (iframeQueue.length >= MAX_IFRAME_QUEUE_SIZE) {
        console.log("[douyin-downloader] detail iframe queue full", {
            vid: taskKey,
            activeCount: activeIframeCount,
            queueSize: iframeQueue.length
        });
        return Promise.resolve(null);
    }

    let resolveTask;
    const basePromise = new Promise(resolve => {
        resolveTask = resolve;
    });
    const task = {
        vid: taskKey,
        queuedAt: Date.now(),
        resolve: resolveTask,
        queueTimer: null,
        settled: false
    };
    const sharedPromise = basePromise.finally(() => {
        if (iframeTasks.get(taskKey) === sharedPromise) {
            iframeTasks.delete(taskKey);
        }
    });
    iframeTasks.set(taskKey, sharedPromise);
    iframeQueue.push(task);
    task.queueTimer = setTimeout(() => {
        const taskIndex = iframeQueue.indexOf(task);
        if (taskIndex === -1 || task.settled) return;
        iframeQueue.splice(taskIndex, 1);
        console.log("[douyin-downloader] detail iframe queue timeout", {
            vid: taskKey,
            queuedForMs: Date.now() - task.queuedAt,
            activeCount: activeIframeCount,
            queueSize: iframeQueue.length
        });
        settleQueuedIframeTask(task, null);
    }, IFRAME_QUEUE_TIMEOUT_MS);

    console.log("[douyin-downloader] detail iframe task queued", {
        vid: taskKey,
        activeCount: activeIframeCount,
        queueSize: iframeQueue.length
    });
    runNextIframeTask();
    return sharedPromise;
}

// 解析结果缓存：同一视频在 30 秒内重复解析直接复用，避免每次点击都重新扫描 React fiber
const DETAIL_CACHE_TTL_MS = 30000;
const detailCache = new Map();

async function resolvePageVideoDetail(vid, forceIframe = false) {
    if (!isValidVid(vid)) {
        console.log("[douyin-downloader] inspector rejected invalid vid", { vid });
        return null;
    }
    // 缓存命中：30 秒内同一视频直接复用上次解析结果
    const cacheKey = String(vid);
    const cached = detailCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        console.log("[douyin-downloader] fast-resolve: cache hit", { vid: cacheKey });
        return cached.detail;
    }
    const detail = await resolvePageVideoDetailUncached(vid, forceIframe);
    if (detail) {
        detailCache.set(cacheKey, { detail, expires: Date.now() + DETAIL_CACHE_TTL_MS });
        console.log("[douyin-downloader] fast-resolve: cached", { vid: cacheKey });
    }
    return detail;
}

async function resolvePageVideoDetailUncached(vid, forceIframe = false) {
    if (!isValidVid(vid)) {
        console.log("[douyin-downloader] inspector rejected invalid vid", { vid });
        return null;
    }

    const escapedVid = window.CSS?.escape ? CSS.escape(String(vid)) : String(vid);
    const exactContainers = inspector("query-exact-containers", () => document.querySelectorAll(
        `.video_${escapedVid}.basePlayerContainer, .video_${escapedVid} .basePlayerContainer, .video_${escapedVid}`
    ), null);
    const containers = exactContainers && exactContainers.length > 0
        ? Array.from(exactContainers)
        : inspector("query-all-containers", () => Array.from(document.querySelectorAll(".basePlayerContainer")), []);

    let fallbackDetail = null;
    for (const container of containers) {
        const awemeInfo = inspector("scan-container", () => findAwemeInfo(container, vid));
        const detail = awemeInfo && inspector("convert-detail", () => toVideoDetail(awemeInfo, vid));
        if (detail) {
            if (!fallbackDetail) fallbackDetail = detail;
            if (hasAllowedVideoCandidates(detail)) {
                console.log("[douyin-downloader] fast-resolve: direct fiber hit", { vid });
                return detail;
            }
        }
    }

    // Direct-read mode: never wait on a hidden iframe that reloads the whole
    // video page. Use the page data we already have, grafting the currently
    // playing <video> currentSrc as the download URL, and return immediately.
    if (fallbackDetail) {
        try {
            attachLiveVideoSource(fallbackDetail);
        } catch (e) {
            console.log("[douyin-downloader] fast-resolve attach live source failed", { vid, error: String(e && e.message || e) });
        }
        console.log("[douyin-downloader] fast-resolve: page detail + live source", {
            vid,
            candidateCount: fallbackDetail.bitRateList?.length || 0
        });
        return fallbackDetail;
    }

    // No aweme info found at all: build a minimal detail straight from the
    // live <video> element + page DOM, so clicking download never blocks.
    const live = await waitForLiveVideoSource();
    if (live) {
        console.log("[douyin-downloader] fast-resolve: minimal live-only detail", { vid });
        return {
            vid: String(vid),
            creator: readCreatorFromDom(),
            description: readDescriptionFromDom(),
            tagList: readTagsFromDom(),
            bitRateList: [liveToBitRate(live)]
        };
    }

    console.log("[douyin-downloader] fast-resolve: nothing found on page", { vid });
    return null;
}

// Pick the currently-playing <video> element on the page.
// 等待一小段时间，让正在加载的 <video> 暴露播放地址，避免在播放前点击下载而拿不到链接。
async function waitForLiveVideoSource(maxWaitMs = 800) {
    const deadline = Date.now() + maxWaitMs;
    let live = getLiveVideoSource();
    while (!live && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 120));
        live = getLiveVideoSource();
    }
    return live;
}

function getLiveVideoSource() {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
        const src = v.currentSrc || v.src;
        if (!src || !src.startsWith("https:")) continue;
        const w = v.videoWidth || 0, h = v.videoHeight || 0;
        if ((!v.paused || v.currentTime > 0) && w && h) {
            return { url: src, width: w, height: h };
        }
    }
    for (const v of videos) {
        const src = v.currentSrc || v.src;
        if (src && src.startsWith("https:") && v.videoWidth && v.videoHeight) {
            return { url: src, width: v.videoWidth, height: v.videoHeight };
        }
    }
    return null;
}

function liveToBitRate(live) {
    const res = Math.min(live.width, live.height);
    return {
        bitRate: 0,
        dataSize: 0,
        width: live.width,
        height: live.height,
        format: "mp4",
        resolutionString: res >= 2160 ? "4K" : res >= 1440 ? "2K" : `${res}P`,
        resolutionNumber: res,
        urlList: [live.url]
    };
}

// If the detail lacks a usable candidate, graft the live currentSrc onto it.
function attachLiveVideoSource(detail) {
    const has = detail.bitRateList && detail.bitRateList.some(b => b.urlList.some(isAllowedVideoCandidateUrl));
    if (has) return;
    const live = getLiveVideoSource();
    if (live) {
        detail.bitRateList = detail.bitRateList || [];
        detail.bitRateList.push(liveToBitRate(live));
    }
}

// 当前选择的文件名生成逻辑模式（由设置页决定：primary 主逻辑 / backup 备用逻辑）。
let fileNameLogicMode = "primary";

// 备用逻辑：通过页面卡片元素精确定位当前视频所在的卡片。
function getActiveFeedItem() {
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    if (active) return active.closest('[data-e2e="feed-item"], [data-e2e="feed-video"]') || active;
    const v = Array.from(document.querySelectorAll("video")).find(v => !v.paused);
    if (v) return v.closest('[data-e2e="feed-item"], [data-e2e="feed-video"]') || v.parentElement;
    const items = Array.from(document.querySelectorAll('[data-e2e="feed-item"]'));
    return items.find(el => {
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
    }) || items[0] || null;
}

function readCreatorFromDomBackup() {
    const item = getActiveFeedItem();
    return item?.querySelector('[data-e2e="feed-video-nickname"]')?.textContent?.trim() || "";
}

function readDescriptionFromDomBackup() {
    const item = getActiveFeedItem();
    return item?.querySelector('[data-e2e="video-desc"]')?.textContent?.trim() || "";
}

function readCreatorFromDom() {
    if (fileNameLogicMode === "backup") {
        const creator = readCreatorFromDomBackup();
        if (creator) return creator;
    }
    let creator = "";
    try {
        creator = document.querySelector('[data-e2e="video-author-nickname"]')?.textContent?.trim()
            || document.querySelector('[data-e2e="feed-video-nickname"]')?.textContent?.trim()
            || document.querySelector('.video-info-detail .name')?.textContent?.trim()
            || document.querySelector('[data-e2e="feed-card-author-name"]')?.textContent?.trim()
            || "";
    } catch { creator = ""; }
    // 主逻辑未读到作者时，自动回退到备用逻辑（2号生成）兜底
    if (!creator && fileNameLogicMode !== "backup") {
        creator = readCreatorFromDomBackup() || "";
    }
    return creator;
}

function readDescriptionFromDom() {
    if (fileNameLogicMode === "backup") {
        const desc = readDescriptionFromDomBackup();
        if (desc) return desc.replace(/\s*展开$/, "").trim();
    }
    let desc = "";
    try {
        desc = (document.querySelector('[data-e2e="video-desc"]')?.textContent?.trim()
            || document.querySelector('.video-info-detail .title')?.textContent?.trim()
            || document.querySelector('[data-e2e="feed-card-video-desc"]')?.textContent?.trim()
            || "").replace(/\s*展开$/, "").trim();
    } catch { desc = ""; }
    // 主逻辑未读到描述时，自动回退到备用逻辑（2号生成）兜底
    if (!desc && fileNameLogicMode !== "backup") {
        desc = (readDescriptionFromDomBackup() || "").replace(/\s*展开$/, "").trim();
    }
    return desc;
}

function readTagsFromDom() {
    try {
        const text = readDescriptionFromDom();
        const tags = text.match(/#([^#\s]+)/g) || [];
        return [...new Set(tags)].slice(0, 8);
    } catch { return []; }
}

window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const {type, data} = event.data;
    if (type === "FETCH_AWEME_DETAIL_REQ") {
        await fetch(data.url, {method: "GET"});
        return;
    }
    if (type !== PAGE_VIDEO_DETAIL_REQUEST) return;
    // 读取设置页选择的文件名生成逻辑（主/备用），用于决定作者、描述的读取方式。
    fileNameLogicMode = data.fileNameLogic === "backup" ? "backup" : "primary";

    let detail = null;
    try {
        detail = await resolvePageVideoDetail(data.vid, data.forceIframe === true);
    } catch (error) {
        console.log("[douyin-downloader] page player detail resolution failed", {
            vid: data.vid,
            forceIframe: data.forceIframe === true,
            error
        });
    }
    console.log("[douyin-downloader] page player detail resolved", {
        vid: data.vid,
        forceIframe: data.forceIframe === true,
        found: Boolean(detail),
        candidateCount: detail?.bitRateList?.length || 0
    });
    window.postMessage({
        type: PAGE_VIDEO_DETAIL_RESPONSE,
        data: {requestId: data.requestId, detail}
    }, "*");
});

// 标记 fetcher 已注入完成，供 content 脚本在发送解析请求前确认就绪
try { window.__douyinFetcherReady = true; } catch (e) {}
