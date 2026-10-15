/* ============================================================
 * JKP v2.2 新增功能模块（独立注入，不修改原逻辑）
 * 主页检测：推荐流 / 视频卡片上自动挂载下载按钮
 * 快速下载：解析与下载并行，有播放地址立即下载，不互相阻塞
 * ============================================================ */
(function () {
  "use strict";

  // ---- message types (same protocol as main module) ----
  var MSG = {
    DOWNLOAD_VIDEO_REQ: "DOWNLOAD_VIDEO_REQ",
    DOWNLOAD_VIDEO_RESP: "DOWNLOAD_VIDEO_RESP",
    RESOLVE_PAGE_VIDEO_DETAIL_REQ: "RESOLVE_PAGE_VIDEO_DETAIL_REQ",
    RESOLVE_PAGE_VIDEO_DETAIL_RESP: "RESOLVE_PAGE_VIDEO_DETAIL_RESP"
  };

  // ---- chrome / browser alias ----
  var C = (typeof globalThis !== "undefined" && globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id) ? globalThis.browser : (globalThis.chrome || {});

  // ---- helper: sleep ----
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ---- extract vid from href / url string ----
  function vidFromHref(href) {
    if (!href) return "";
    var m = href.match(/\/(?:video|note)\/(\d+)/);
    if (m && m[1]) return m[1];
    m = href.match(/[?&](?:modal_id|vid|aweme_id)=(\d+)/);
    if (m && m[1]) return m[1];
    try {
      var seg = href.split("?")[0].split("#")[0].split("/").filter(Boolean);
      var last = seg[seg.length - 1];
      if (last && /^\d+$/.test(last)) return last;
    } catch (e) {}
    return "";
  }

  // ---- extract vid from a dom element ----
  function vidFromElement(el) {
    if (!el) return "";
    if (el.getAttribute && /^\d{6,}$/.test(el.getAttribute("data-e2e-vid") || "")) return el.getAttribute("data-e2e-vid");
    var nested = el.querySelector && el.querySelector("[data-e2e-vid]");
    if (nested && /^\d{6,}$/.test(nested.getAttribute("data-e2e-vid") || "")) return nested.getAttribute("data-e2e-vid");
    if (el.classList) {
      for (var i = 0; i < el.classList.length; i++) {
        var mm = el.classList[i].match(/^video_(\d+)$/);
        if (mm && mm[1]) return mm[1];
      }
    }
    var links = el.querySelectorAll ? el.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="]') : [];
    for (var j = 0; j < links.length; j++) {
      var v = vidFromHref(links[j].getAttribute("href") || "");
      if (v) return v;
    }
    if (el.getAttribute && el.getAttribute("href")) return vidFromHref(el.getAttribute("href"));
    return "";
  }

  // ---- resolve video detail via fetcher (postMessage protocol) ----
  function resolveDetail(vid) {
    var requestId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("r" + Math.random().toString(36).slice(2));
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        window.removeEventListener("message", onMsg);
        resolve(null);
      }, 20000);
      function onMsg(e) {
        if (e.source !== window || !e.data || typeof e.data !== "object") return;
        if (e.data.type !== MSG.RESOLVE_PAGE_VIDEO_DETAIL_RESP) return;
        if (e.data.data && e.data.data.requestId === requestId) {
          clearTimeout(timer);
          window.removeEventListener("message", onMsg);
          resolve(e.data.data.detail || null);
        }
      }
      window.addEventListener("message", onMsg);
      var deadline = Date.now() + 1500;
      function send() {
        if (window.__douyinFetcherReady || Date.now() >= deadline) {
          window.postMessage({ type: MSG.RESOLVE_PAGE_VIDEO_DETAIL_REQ, data: { requestId: requestId, vid: String(vid), forceIframe: false } }, "*");
        } else {
          setTimeout(send, 50);
        }
      }
      send();
    });
  }

  // ---- send download request to background ----
  function requestDownload(vid, page, url, mediaUrl, w, h, detail) {
    try {
      return C.runtime.sendMessage({
        type: MSG.DOWNLOAD_VIDEO_REQ,
        data: {
          vid: String(vid),
          page: page,
          url: url,
          mediaUrl: mediaUrl || "",
          videoWidth: w || 0,
          videoHeight: h || 0,
          pageVideoDetail: detail || undefined
        }
      }).then(function (resp) {
        return (resp && resp.type === MSG.DOWNLOAD_VIDEO_RESP) ? resp : null;
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ---- find <video> element belonging to a vid ----
  function findVideoForVid(vid) {
    var escaped = (window.CSS && CSS.escape) ? CSS.escape(String(vid)) : String(vid);
    var scope = document.querySelector(".video_" + escaped) || document.querySelector(".video_" + escaped + " .basePlayerContainer");
    if (scope) {
      var v = scope.querySelector("video");
      if (v) return v;
    }
    // fallback: any playing video on the page (recommend feed)
    var videos = Array.from(document.querySelectorAll("video"));
    var playing = videos.filter(function (x) { return !x.paused && x.currentTime > 0; });
    if (playing.length) return playing[0];
    return videos[0] || null;
  }

  // ---- page kind (same semantics as main module) ----
  function pageKind() {
    try {
      var host = location.host;
      var path = location.pathname;
      if (host === "live.douyin.com") return "live";
      if (path.indexOf("/user/") === 0) return "user";
      if (path.indexOf("/video/") === 0) return "video";
      if (path.indexOf("/follow") === 0) return "follow";
      if (path.indexOf("/discover") === 0) return "discover";
      if (path.indexOf("/search") === 0) return "search";
      if (host === "www.douyin.com" && (path === "/" || path === "")) return "recommend";
    } catch (e) {}
    return "unknown";
  }

  // ---- download one video: parse runs in parallel, media url downloads instantly ----
  async function downloadVid(vid) {
    if (!vid || !/^\d{6,}$/.test(String(vid))) return;
    var page = pageKind();
    var url = (function () {
      try { return decodeURIComponent(location.href).replaceAll(" ", "+"); } catch (e) { return location.href; }
    })();
    var video = findVideoForVid(vid);
    var mediaUrl = (video && (video.currentSrc || video.src)) || "";
    var w = (video && video.videoWidth) || 0;
    var h = (video && video.videoHeight) || 0;
    // start resolution in parallel, never block download
    var detailPromise = resolveDetail(vid);
    if (mediaUrl) {
      // fast window: wait up to 800ms for resolution, then download immediately anyway
      var fast = await Promise.race([detailPromise, sleep(800)]);
      await requestDownload(vid, page, url, mediaUrl, w, h, fast || undefined);
    } else {
      // no media url on page: wait for resolution with a 3s cap so batch never stalls
      var detail = await Promise.race([detailPromise, sleep(3000)]);
      await requestDownload(vid, page, url, "", w, h, detail || undefined);
    }
  }

  // ---- home feed detection: attach download button to feed cards ----
  // only feed cards get a button here; bare video links already get the grid
  // button from the main module, so no duplicate is created
  function enhanceHomeFeed() {
    var cards = document.querySelectorAll('[data-e2e="feed-item"], [data-e2e="feed-video"]');
    cards.forEach(function (card) {
      if (card.querySelector(".douyin-feed-download")) return;
      if (card.closest(".douyin-feed-download, .douyin-grid-download")) return;
      if (card.closest("[data-e2e='feed-live']")) return;
      var vid = vidFromElement(card);
      if (!vid) return;
      var btn = document.createElement("img");
      btn.className = "douyin-feed-download";
      btn.title = "下载该视频";
      try { btn.src = C.runtime.getURL("/download_button.svg"); } catch (e) {}
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        downloadVid(vid);
      }, { capture: true });
      if (getComputedStyle(card).position === "static") card.style.position = "relative";
      card.appendChild(btn);
    });
  }

  // ---- init ----
  // NOTE: frosted-glass buttons (floating batch button + main player overlay
  // button) are removed per user request. Only glass-transparent card buttons are kept.
  function init() {
    try { enhanceHomeFeed(); } catch (e) {}
    setInterval(function () {
      try { enhanceHomeFeed(); } catch (e) {}
    }, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
