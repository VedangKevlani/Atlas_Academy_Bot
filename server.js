import "dotenv/config";
import { createAtlasBot } from "atlas-bot-sdk";
import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import { Readable } from "node:stream";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const LEARNING_STYLES = ["audio", "visual", "kinesthetic"];
const VISUAL_FORMATS = ["infographic", "video", "slide_deck"];

for (const key of ["ATLAS_BOT_TOKEN", "SUPABASE_URL", "SUPABASE_KEY", "PUBLIC_BASE_URL"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Set it in your deployment platform's config, not just .env.`);
    process.exit(1);
  }
}

// role -> course-topic mapping, based on the org's actual role/skill list.
// There's no roles/curriculum table in Supabase yet (the "roles" table exists
// but is empty with no link to paths), so this is maintained here by hand.
// Skills with no matching course in the catalog are mapped to the closest
// available one instead of being dropped — noted per role below. The
// Quality Engineer roles lean almost entirely on "Postman" since the catalog
// has no dedicated QA/testing courses at all (no Selenium, Cucumber,
// LoadRunner, or general software-testing content exists to map to).
const ROLE_TOPIC_KEYWORDS = {
  // UNIX -> closest available is Linux CLI
  "Java Backend Engineer": ["Java", "Spring Kotlin", "Linux CLI"],
  "UI & Frontend Engineer": ["React", "HTML", "CSS", "JavaScript", "Next.js"],
  // ETL Testing -> Informatica (ETL tooling) and Kafka (data pipelines); SQL -> Database
  "Data Engineer": ["Python", "Database", "Informatica", "Kafka"],
  // Project Management for IT Professionals / People Management / Planning -> no direct course
  "Technical Project Manager": ["Corporate Strategy", "Product Engineering", "Self-Mastery"],
  // .NET MVC / C# Programming -> C#/.NET; SQL -> Database
  ".NET Engineer": ["C#/.NET", "Database", "JavaScript"],
  // Software QA, LoadRunner, Cucumber -> no matching course; Java 8 -> Java; Postman is the closest testing-tool course
  "Quality Engineer (Load Runner)": ["Java", "Postman"],
  // Software QA, Software/Agile Testing -> no matching course; AWS is explicit
  "Quality Engineer": ["AWS", "Postman"],
  // Cucumber, Selenium, Functional/Agile Testing -> no matching course at all
  "Quality Engineer (Functional Testing)": ["Postman"]
};

const HLS_MIME_TYPES = new Set(["application/x-mpegurl", "application/vnd.apple.mpegurl"]);

// shared fullscreen + landscape-rotate controls for the video/infographic/deck
// viewer pages — embedding webviews often lock portrait and won't let a plain
// <video>/<img> go fullscreen or rotate on its own, so we do it ourselves
function viewerChromeScript({ rotatable }) {
  return `
  const stageEl = document.getElementById("stage");
  const fsBtn = document.getElementById("fullscreen");
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else if (stageEl.requestFullscreen) {
      stageEl.requestFullscreen().then(() => {
        screen.orientation?.lock?.("landscape").catch(() => {});
      }).catch(() => {});
    } else if (stageEl.webkitRequestFullscreen) {
      stageEl.webkitRequestFullscreen();
    }
  });
  ${rotatable ? `
  let rotated = false;
  const rotateBtn = document.getElementById("rotate");
  const controlsEl = document.getElementById("controls");
  rotateBtn.addEventListener("click", () => {
    rotated = !rotated;
    stageEl.classList.toggle("rotated", rotated);
    // controls take up space / overlay the rotated fullscreen content — hide
    // them once rotated, tap the stage to bring them back to un-rotate
    controlsEl.classList.toggle("hidden", rotated);
  });
  stageEl.addEventListener("click", () => {
    if (rotated) controlsEl.classList.toggle("hidden");
  });` : ""}
  `;
}

const VIEWER_CHROME_STYLE = `
  #stage.rotated {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vh;
    height: 100vw;
    transform-origin: top left;
    transform: rotate(90deg) translateY(-100%);
    z-index: 1;
  }
  #controls { position: relative; z-index: 2; display: flex; flex-direction: column; gap: 8px; padding: 10px; background: #000; }
  #controls.hidden { display: none; }
  #controls .row { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
  #controls button, #controls a.tool { background: #333; color: #eee; border: none; border-radius: 6px; padding: 8px 14px; font-size: 15px; cursor: pointer; text-decoration: none; display: inline-block; }
  #controls button:disabled { opacity: 0.4; cursor: default; }
  #download {
    display: block;
    background: #2d7d46;
    color: #fff;
    text-align: center;
    padding: 14px;
    font-size: 17px;
    font-weight: 600;
    border-radius: 8px;
    text-decoration: none;
  }
`;

function renderHlsPlayer(items) {
  const itemsJson = JSON.stringify(items).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  body { display: flex; flex-direction: column; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; transition: transform 0.2s; }
  #stage video { width: 100%; height: 100%; object-fit: contain; }
  ${VIEWER_CHROME_STYLE}
  #title { color: #eee; font-family: system-ui, sans-serif; text-align: center; padding: 6px; font-size: 14px; }
</style>
</head>
<body>
<div id="stage"><video id="player" controls autoplay playsinline></video></div>
<div id="title"></div>
<div id="controls">
  <div class="row">
    <button id="prev">‹ Prev</button>
    <span id="counter"></span>
    <button id="next">Next ›</button>
  </div>
  <div class="row">
    <button id="rotate">⟳ Rotate</button>
    <button id="fullscreen">⛶ Fullscreen</button>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script>
  const items = ${itemsJson};
  let i = 0;
  let hls = null;
  const video = document.getElementById("player");
  const titleEl = document.getElementById("title");
  const counter = document.getElementById("counter");
  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");

  function load(idx) {
    i = idx;
    const src = items[i].src;
    titleEl.textContent = items[i].title || "";
    counter.textContent = (i + 1) + " / " + items.length;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === items.length - 1;
    if (hls) { hls.destroy(); hls = null; }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      titleEl.textContent = "Your browser can't play this video.";
    }
  }
  prevBtn.addEventListener("click", () => i > 0 && load(i - 1));
  nextBtn.addEventListener("click", () => i < items.length - 1 && load(i + 1));
  if (items.length <= 1) { prevBtn.style.display = "none"; nextBtn.style.display = "none"; counter.style.display = "none"; }
  ${viewerChromeScript({ rotatable: true })}
  load(0);
</script>
</body>
</html>`;
}

function renderInfographicViewer(items) {
  const itemsJson = JSON.stringify(items).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Infographic</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; }
  body { display: flex; flex-direction: column; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; transition: transform 0.2s; }
  #stage img { max-width: 100%; max-height: 100%; object-fit: contain; transition: transform 0.15s; }
  ${VIEWER_CHROME_STYLE}
  #title { color: #eee; font-family: system-ui, sans-serif; text-align: center; padding: 6px; font-size: 14px; }
</style>
</head>
<body>
<div id="stage"><img id="pic" alt="Infographic"></div>
<div id="title"></div>
<div id="controls">
  <div class="row">
    <button id="prev">‹ Prev</button>
    <span id="counter"></span>
    <button id="next">Next ›</button>
  </div>
  <div class="row">
    <button id="zoomOut">− Zoom</button>
    <button id="zoomIn">+ Zoom</button>
    <button id="rotate">⟳ Rotate</button>
    <button id="fullscreen">⛶ Fullscreen</button>
  </div>
  <a id="download" target="_blank" rel="noopener">⬇️ Download to Device</a>
</div>
<script>
  const items = ${itemsJson};
  let i = 0;
  let zoom = 1;
  let deg = 0;
  const img = document.getElementById("pic");
  const titleEl = document.getElementById("title");
  const counter = document.getElementById("counter");
  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");
  const downloadLink = document.getElementById("download");

  function applyTransform() { img.style.transform = "scale(" + zoom + ") rotate(" + deg + "deg)"; }

  function load(idx) {
    i = idx;
    img.src = items[i].src;
    titleEl.textContent = items[i].title || "";
    counter.textContent = (i + 1) + " / " + items.length;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === items.length - 1;
    downloadLink.href = items[i].download || "#";
    zoom = 1; deg = 0; applyTransform();
  }
  prevBtn.addEventListener("click", () => i > 0 && load(i - 1));
  nextBtn.addEventListener("click", () => i < items.length - 1 && load(i + 1));
  if (items.length <= 1) { prevBtn.style.display = "none"; nextBtn.style.display = "none"; counter.style.display = "none"; }
  document.getElementById("zoomIn").addEventListener("click", () => { zoom = Math.min(3, zoom + 0.25); applyTransform(); });
  document.getElementById("zoomOut").addEventListener("click", () => { zoom = Math.max(0.5, zoom - 0.25); applyTransform(); });
  document.getElementById("rotate").addEventListener("click", () => { deg = (deg + 90) % 360; applyTransform(); });
  ${viewerChromeScript({ rotatable: false })}
  load(0);
</script>
</body>
</html>`;
}

function renderAudioPlayer(items) {
  const itemsJson = JSON.stringify(items).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audio</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; }
  body { display: flex; flex-direction: column; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  #stage audio { width: 100%; max-width: 480px; }
  ${VIEWER_CHROME_STYLE}
  #title { color: #eee; font-family: system-ui, sans-serif; text-align: center; padding: 6px; font-size: 14px; }
</style>
</head>
<body>
<div id="stage"><audio id="player" controls autoplay></audio></div>
<div id="title"></div>
<div id="controls">
  <div class="row">
    <button id="prev">‹ Prev</button>
    <span id="counter"></span>
    <button id="next">Next ›</button>
  </div>
  <a id="download" target="_blank" rel="noopener">⬇️ Download to Device</a>
</div>
<script>
  const items = ${itemsJson};
  let i = 0;
  const audio = document.getElementById("player");
  const titleEl = document.getElementById("title");
  const counter = document.getElementById("counter");
  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");
  const downloadLink = document.getElementById("download");

  function load(idx) {
    i = idx;
    audio.src = items[i].src;
    titleEl.textContent = items[i].title || "";
    counter.textContent = (i + 1) + " / " + items.length;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === items.length - 1;
    downloadLink.href = items[i].download || "#";
  }
  prevBtn.addEventListener("click", () => i > 0 && load(i - 1));
  nextBtn.addEventListener("click", () => i < items.length - 1 && load(i + 1));
  audio.addEventListener("ended", () => { if (i < items.length - 1) load(i + 1); });
  if (items.length <= 1) { prevBtn.style.display = "none"; nextBtn.style.display = "none"; counter.style.display = "none"; }
  load(0);
</script>
</body>
</html>`;
}

// strips a bucket's public-URL prefix off storage_path when it's a full URL,
// so it's always safe to hand to supabase.storage.from(bucket).list(...)
function relativeStoragePath(bucket, storagePath) {
  if (!/^https?:\/\//i.test(storagePath)) return storagePath;
  const marker = `/object/public/${bucket}/`;
  const idx = storagePath.indexOf(marker);
  return idx >= 0 ? storagePath.slice(idx + marker.length) : storagePath;
}

function resolveAssetUrl(asset) {
  return /^https?:\/\//i.test(asset.storage_path)
    ? asset.storage_path
    : supabase.storage.from(asset.bucket).getPublicUrl(asset.storage_path).data.publicUrl;
}

const EXTENSION_BY_MIME = {
  "audio/mp4": "m4a",
  "image/avif": "avif",
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf"
};

function extensionFromUrl(url, mimeType) {
  const match = url.split("?")[0].match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1] : EXTENSION_BY_MIME[mimeType] ?? "bin";
}

function sanitizeFilename(title) {
  return title.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "download";
}

// downloads a whole file into memory and uploads it as a native chat
// attachment, so it saves via the chat client's own attachment-save UI
// instead of depending on a web page's download link working inside
// whatever webview opened it. Only works for genuinely single-file assets —
// video (HLS, no single file) and folder-based decks (many slide images)
// aren't sendable this way; callers should check for those first.
// audio in this catalog runs up to ~100MB, and the whole file has to be
// buffered in memory before it can be uploaded (the SDK's send methods take
// raw bytes, not a stream) — cap it well under typical homeserver upload
// limits so an oversized file fails fast with a clear message instead of
// burning memory on a buffer that was going to be rejected anyway
const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;

async function sendAssetAsAttachment(ctx, asset) {
  const assetUrl = resolveAssetUrl(asset);
  const upstream = await fetch(assetUrl);
  if (!upstream.ok || !upstream.body) return { sent: false, reason: "fetch_failed" };

  const contentLength = parseInt(upstream.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_ATTACHMENT_BYTES) {
    await upstream.body.cancel().catch(() => {});
    return { sent: false, reason: "too_large" };
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const mimetype = asset.mime_type || upstream.headers.get("content-type") || "application/octet-stream";
  const filename = `${sanitizeFilename(asset.title)}.${extensionFromUrl(assetUrl, mimetype)}`;

  if (asset.asset_type === "audio") {
    await ctx.sendVoice(bytes, { filename, mimetype });
  } else if (asset.asset_type === "infographic") {
    await ctx.sendImage(bytes, { filename, mimetype });
  } else if (asset.asset_type === "deck") {
    await ctx.sendDocument(bytes, { filename, mimetype });
  } else {
    return { sent: false, reason: "unsupported_type" };
  }
  return { sent: true };
}

// slides: [{ src, download }]
function renderSlideDeckViewer(slides) {
  const slidesJson = JSON.stringify(slides).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slide Deck</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; color: #eee; font-family: system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  #stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
  ${VIEWER_CHROME_STYLE}
  #counter { min-width: 4em; text-align: center; }
</style>
</head>
<body>
<div id="stage"><img id="slide" alt="Slide"></div>
<div id="controls">
  <div class="row">
    <button id="prev">‹ Prev</button>
    <span id="counter"></span>
    <button id="next">Next ›</button>
  </div>
  <div class="row">
    <button id="fullscreen">⛶ Fullscreen</button>
  </div>
  <a id="download" target="_blank" rel="noopener">⬇️ Download This Slide</a>
</div>
<script>
  const slides = ${slidesJson};
  let i = 0;
  const img = document.getElementById("slide");
  const counter = document.getElementById("counter");
  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");
  const downloadLink = document.getElementById("download");

  function render() {
    img.src = slides[i].src;
    counter.textContent = (i + 1) + " / " + slides.length;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === slides.length - 1;
    downloadLink.href = slides[i].download || "#";
  }
  function go(delta) {
    i = Math.min(slides.length - 1, Math.max(0, i + delta));
    render();
  }
  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });
  ${viewerChromeScript({ rotatable: false })}
  render();
</script>
</body>
</html>`;
}

// resolves one media_assets row into { title, src, download }, handling the
// folder-of-slide-images case by picking its first slide as a representative
// image (used only by the playlist route's infographic path, which never
// receives deck rows — decks aren't included in playlists, see /playlist).
// `download` is omitted for video since HLS has no single downloadable file.
async function resolvePlayableAsset(asset) {
  const isVideo = HLS_MIME_TYPES.has((asset.mime_type || "").toLowerCase());
  const download = isVideo ? null : `${PUBLIC_BASE_URL}/download/${asset.id}`;

  if (asset.storage_path.endsWith("/")) {
    const folder = relativeStoragePath(asset.bucket, asset.storage_path).replace(/\/$/, "");
    const { data: files } = await supabase.storage.from(asset.bucket).list(folder);
    const first = (files ?? [])
      .filter((f) => /\.(avif|webp|png|jpe?g|gif)$/i.test(f.name))
      .sort((a, b) => {
        const na = parseInt(a.name, 10), nb = parseInt(b.name, 10);
        return !isNaN(na) && !isNaN(nb) ? na - nb : a.name.localeCompare(b.name);
      })[0];
    if (!first) return null;
    return {
      title: asset.title,
      src: supabase.storage.from(asset.bucket).getPublicUrl(`${folder}/${first.name}`).data.publicUrl,
      download: `${PUBLIC_BASE_URL}/download/${asset.id}?file=${encodeURIComponent(first.name)}`
    };
  }
  return { title: asset.title, src: resolveAssetUrl(asset), download };
}

// proxies media_assets storage objects under our own domain so the
// Supabase project URL is never shown to or hit directly by the user
async function serveMedia(req, res) {
  const assetId = decodeURIComponent(req.url.slice("/media/".length).split("?")[0]);

  const { data: asset, error } = await supabase
    .from("media_assets")
    .select("bucket, storage_path, mime_type, asset_type, title")
    .eq("id", assetId)
    .eq("is_published", true)
    .maybeSingle();

  if (error || !asset) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  // some decks are stored as a folder of numbered slide images rather than
  // a single file — storage_path ends in "/" for those, list and view them
  if (asset.storage_path.endsWith("/")) {
    const folder = relativeStoragePath(asset.bucket, asset.storage_path).replace(/\/$/, "");
    const { data: files, error: listError } = await supabase.storage.from(asset.bucket).list(folder);

    if (listError || !files || files.length === 0) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Failed to fetch media");
      return;
    }

    const slides = files
      .filter((f) => /\.(avif|webp|png|jpe?g|gif)$/i.test(f.name))
      .sort((a, b) => {
        const na = parseInt(a.name, 10);
        const nb = parseInt(b.name, 10);
        return !isNaN(na) && !isNaN(nb) ? na - nb : a.name.localeCompare(b.name);
      })
      .map((f) => ({
        src: supabase.storage.from(asset.bucket).getPublicUrl(`${folder}/${f.name}`).data.publicUrl,
        download: `${PUBLIC_BASE_URL}/download/${assetId}?file=${encodeURIComponent(f.name)}`
      }));

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSlideDeckViewer(slides));
    return;
  }

  const assetUrl = resolveAssetUrl(asset);

  // video assets are HLS packages (a master.m3u8 manifest plus separate
  // segment files), not a single playable file — chat clients can't render
  // that inline, so hand back a page that plays it instead of the raw manifest
  if (HLS_MIME_TYPES.has((asset.mime_type || "").toLowerCase())) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHlsPlayer([{ title: asset.title, src: assetUrl }]));
    return;
  }

  // infographics get a real viewer (zoom/rotate/fullscreen/download) instead
  // of a raw image byte stream, which left the client's native (often
  // portrait-locked) image viewer as the only way to look at it
  if (asset.asset_type === "infographic") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderInfographicViewer([{ title: asset.title, src: assetUrl, download: `${PUBLIC_BASE_URL}/download/${assetId}` }]));
    return;
  }

  // audio gets a real player with a download button too, instead of relying
  // on whatever native handling the chat client gives a bare audio link
  if (asset.asset_type === "audio") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderAudioPlayer([{ title: asset.title, src: assetUrl, download: `${PUBLIC_BASE_URL}/download/${assetId}` }]));
    return;
  }

  // forward Range so players can seek/probe before playing — without this
  // every request gets the full file back with no Accept-Ranges, and chat
  // clients that range-probe before playback treat that as unplayable
  const rangeHeader = req.headers.range;
  const upstream = await fetch(assetUrl, rangeHeader ? { headers: { Range: rangeHeader } } : {});
  if (!upstream.ok || !upstream.body) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Failed to fetch media");
    return;
  }

  const headers = {
    "Content-Type": asset.mime_type || upstream.headers.get("content-type") || "application/octet-stream",
    "Accept-Ranges": "bytes"
  };
  const contentRange = upstream.headers.get("content-range");
  const contentLength = upstream.headers.get("content-length");
  if (contentRange) headers["Content-Range"] = contentRange;
  if (contentLength) headers["Content-Length"] = contentLength;

  res.writeHead(upstream.status === 206 ? 206 : 200, headers);
  Readable.fromWeb(upstream.body).pipe(res);
}

// serves several media_assets rows (comma-separated ids) as one playable
// sequence with prev/next — used for "play all" on a broad topic/role search.
// assumes every id shares the same renderable kind (built that way by
// deliverPlaylist, which only ever mixes assets of one format at a time)
async function servePlaylist(req, res) {
  const idsParam = decodeURIComponent(req.url.slice("/playlist/".length).split("?")[0]);
  const ids = idsParam.split(",").filter(Boolean);

  const { data: assets, error } = await supabase
    .from("media_assets")
    .select("id, bucket, storage_path, mime_type, asset_type, title")
    .in("id", ids)
    .eq("is_published", true);

  if (error || !assets || assets.length === 0) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const byId = new Map(assets.map((a) => [a.id, a]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  const items = [];
  for (const asset of ordered) {
    const item = await resolvePlayableAsset(asset);
    if (item) items.push(item);
  }

  if (items.length === 0) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Failed to fetch media");
    return;
  }

  const renderer = HLS_MIME_TYPES.has((ordered[0].mime_type || "").toLowerCase())
    ? renderHlsPlayer
    : ordered[0].asset_type === "audio"
      ? renderAudioPlayer
      : renderInfographicViewer;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderer(items));
}

// serves a single media_assets file (or one slide of a folder-based deck,
// via ?file=) with Content-Disposition: attachment so it saves to the
// device instead of opening inline — the download links on the viewer pages
// all point here. Video has no download route: HLS has no single file to
// hand back (it's a manifest plus many segment files), so the video player
// doesn't offer one.
async function serveDownload(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const assetId = decodeURIComponent(url.pathname.slice("/download/".length));
  const fileParam = url.searchParams.get("file");

  const { data: asset, error } = await supabase
    .from("media_assets")
    .select("bucket, storage_path, mime_type, title")
    .eq("id", assetId)
    .eq("is_published", true)
    .maybeSingle();

  if (error || !asset) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  if (HLS_MIME_TYPES.has((asset.mime_type || "").toLowerCase())) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("This video is streamed and isn't available as a single downloadable file.");
    return;
  }

  let downloadUrl;
  let filenameHint = asset.title;

  if (asset.storage_path.endsWith("/")) {
    if (!fileParam || !/^[\w.-]+$/.test(fileParam)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing or invalid file parameter");
      return;
    }
    const folder = relativeStoragePath(asset.bucket, asset.storage_path).replace(/\/$/, "");
    downloadUrl = supabase.storage.from(asset.bucket).getPublicUrl(`${folder}/${fileParam}`).data.publicUrl;
    const slideNumber = fileParam.match(/^(\d+)\./)?.[1];
    filenameHint = slideNumber ? `${asset.title} slide ${slideNumber}` : asset.title;
  } else {
    downloadUrl = resolveAssetUrl(asset);
  }

  const upstream = await fetch(downloadUrl);
  if (!upstream.ok || !upstream.body) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Failed to fetch media");
    return;
  }

  const filename = `${sanitizeFilename(filenameHint)}.${extensionFromUrl(downloadUrl, asset.mime_type)}`;

  res.writeHead(200, {
    "Content-Type": asset.mime_type || upstream.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  Readable.fromWeb(upstream.body).pipe(res);
}

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    if (req.url.startsWith("/media/")) {
      serveMedia(req, res).catch((err) => {
        console.error("Media proxy failed:", err.message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
      return;
    }

    if (req.url.startsWith("/playlist/")) {
      servePlaylist(req, res).catch((err) => {
        console.error("Playlist proxy failed:", err.message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
      return;
    }

    if (req.url.startsWith("/download/")) {
      serveDownload(req, res).catch((err) => {
        console.error("Download proxy failed:", err.message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Intellibus Academy Bot is running.");
  })
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// ---------- learning style / format preference ----------

async function getUserPreferences(userId) {
  const { data, error } = await supabase
    .from("user_preferences")
    .select("learning_style, preferred_format")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Supabase preferences lookup failed:", error.message);
    return { style: null, preferredFormat: null };
  }
  return { style: data?.learning_style ?? null, preferredFormat: data?.preferred_format ?? null };
}

async function setUserStyle(userId, style) {
  const { error } = await supabase
    .from("user_preferences")
    .upsert({ user_id: userId, learning_style: style }, { onConflict: "user_id" });

  if (error) console.error("Supabase style upsert failed:", error.message);
}

async function setPreferredFormat(userId, format) {
  // learning_style is NOT NULL — Postgres validates that constraint against
  // the upsert's hypothetical INSERT row before it ever gets to resolving
  // the ON CONFLICT update, so omitting it here fails silently on every call
  const { style } = await getUserPreferences(userId);
  const { error } = await supabase
    .from("user_preferences")
    .upsert({ user_id: userId, learning_style: style, preferred_format: format }, { onConflict: "user_id" });

  if (error) console.error("Supabase preferred_format upsert failed:", error.message);
}

function styleChoiceButtons() {
  return [
    { label: "🎧 Audio",       value: "/setstyle audio" },
    { label: "👀 Visual",      value: "/setstyle visual" },
    { label: "🤸 Kinesthetic", value: "/setstyle kinesthetic" }
  ];
}

// tracks the last choice-prompt sent per room so it can be stripped of its
// NOTE: this used to also edit the previous choice-prompt to strip its
// buttons (decluttering old, no-longer-relevant buttons from scrollback).
// Reverted — that meant calling ctx.editMessage() on nearly every reply, and
// if the client doesn't correctly handle m.replace edit relations, it would
// render each edit as a brand-new message instead of updating in place,
// which looks exactly like the "duplicate messages" bug being reported.
// Suspected but not confirmed — kept simple until that's ruled out.
async function sendChoicesTracked(ctx, text, choices) {
  return ctx.sendChoices(text, choices);
}

async function promptLearningStyle(ctx, intro) {
  await sendChoicesTracked(ctx, intro, styleChoiceButtons());
}

function followUpButtons() {
  return [
    { label: "🎓 Find a new topic",      value: "/findcourse" },
    { label: "🔀 Change learning style", value: "/style"      },
    { label: "🏠 Back to start",         value: "/start"      }
  ];
}

// ---------- content lookup ----------

async function findPathsByTopic(topic) {
  // try an exact topic match first (many paths share a broad topic value
  // like "Java" or "AWS" on purpose) before falling back to substring, which
  // otherwise incidentally matches unrelated topics too (e.g. "java" inside
  // "JavaScript")
  const exact = await supabase
    .from("paths")
    .select("id, slug, topic, title")
    .eq("topic", topic)
    .eq("is_published", true)
    .limit(20);

  if (exact.error) {
    console.error("Supabase path lookup failed:", exact.error.message);
    return [];
  }
  if (exact.data.length > 0) return exact.data;

  const fuzzy = await supabase
    .from("paths")
    .select("id, slug, topic, title")
    .ilike("topic", `%${topic}%`)
    .eq("is_published", true)
    .limit(20);

  if (fuzzy.error) {
    console.error("Supabase path lookup failed:", fuzzy.error.message);
    return [];
  }
  return fuzzy.data;
}

async function findPathBySlug(slug) {
  const { data, error } = await supabase
    .from("paths")
    .select("id, slug, topic, title")
    .eq("slug", slug)
    .eq("is_published", true)
    .maybeSingle();

  if (error) {
    console.error("Supabase path-by-slug lookup failed:", error.message);
    return null;
  }
  return data;
}

function matchRoleName(input) {
  const needle = input.trim().toLowerCase();
  const roles = Object.keys(ROLE_TOPIC_KEYWORDS);
  // exact match must win first — otherwise a plain "Quality Engineer" search
  // would match "Quality Engineer (Load Runner)" purely because it comes
  // first and its name contains the shorter one as a substring
  return roles.find((role) => role.toLowerCase() === needle) ?? roles.find((role) => role.toLowerCase().includes(needle));
}

async function findPathsByRole(roleName) {
  const keywords = ROLE_TOPIC_KEYWORDS[roleName];
  if (!keywords) return [];

  const { data, error } = await supabase
    .from("paths")
    .select("id, slug, topic, title")
    .in("topic", keywords)
    .eq("is_published", true)
    .limit(20);

  if (error) {
    console.error("Supabase role lookup failed:", error.message);
    return [];
  }
  return data;
}

async function findAssetForPath(pathId, format) {
  // media_assets.asset_type stores the format, but under "deck" rather than "slide_deck"
  const assetType = format === "slide_deck" ? "deck" : format;

  // .limit(1) instead of .maybeSingle() — a handful of paths have more than
  // one published row for the same asset_type, which .maybeSingle() treats
  // as an error; take the most recent one instead of failing the lookup
  const { data: assets, error } = await supabase
    .from("media_assets")
    .select("id, title, description")
    .eq("path_id", pathId)
    .eq("asset_type", assetType)
    .eq("is_published", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Supabase media asset lookup failed:", error.message);
    return null;
  }
  const asset = assets?.[0];
  if (!asset) return null;

  return {
    id: asset.id,
    title: asset.title,
    description: asset.description ?? "",
    url: `${PUBLIC_BASE_URL}/media/${asset.id}`
  };
}

// delivers a specific visual format for a specific path, and remembers it as
// the user's default so future visual searches skip the format picker
async function deliverFormat(ctx, path, format) {
  const asset = await findAssetForPath(path.id, format);
  if (!asset) {
    await ctx.sendText(
      `😕 I couldn't find a ${format.replace("_", " ")} for *${path.title}* right now.\n\n` +
      `Try a different format or topic, or contact the Intellibus Academy team for help.`
    );
    return;
  }

  if (VISUAL_FORMATS.includes(format)) await setPreferredFormat(ctx.sender, format);

  const buttons = [{ label: "🔄 Different format, same topic", value: `/formats ${path.slug}` }];
  if (format !== "video") buttons.push({ label: "⬇️ Save to device", value: `/downloadasset ${asset.id}` });
  buttons.push(...followUpButtons());

  await sendChoicesTracked(
    ctx,
    `✅ *${asset.title}*\n\n` +
    `${asset.description}\n\n` +
    `📎 Access it here:\n${asset.url}\n\n` +
    `What would you like to do next?`,
    buttons
  );
}

async function sendFormatChoices(ctx, path) {
  await sendChoicesTracked(
    ctx,
    `Great choice! Here are the available formats for *${path.title}*. Which do you prefer?`,
    [
      { label: "🖼️  Infographic", value: `/getformat infographic ${path.slug}` },
      { label: "🎬  Video",        value: `/getformat video ${path.slug}`       },
      { label: "📊  Slide Deck",   value: `/getformat slide_deck ${path.slug}`  }
    ]
  );
}

// dispatches a single resolved path to the right delivery for the user's
// learning style — this is the one place style branches into content
async function deliverForStyle(ctx, style, preferredFormat, path) {
  if (style === "kinesthetic") {
    await sendChoicesTracked(
      ctx,
      `🤸 *${path.title}* has hands-on flashcards and quizzes waiting for you on the Intellibus platform:\n\n` +
      `🔗 https://intellibus.academy/learning-paths/${path.slug}\n\n` +
      `(You'll need to be logged into your Intellibus Academy account to access it.)\n\n` +
      `What would you like to do next?`,
      followUpButtons()
    );
    return;
  }

  if (style === "audio") {
    const asset = await findAssetForPath(path.id, "audio");
    if (!asset) {
      await ctx.sendText(
        `😕 I couldn't find audio content for *${path.title}* yet.\n\n` +
        `Try /suggest for another topic, or /style to switch how content is delivered.`
      );
      return;
    }
    await sendChoicesTracked(
      ctx,
      `✅ *${asset.title}*\n\n${asset.description}\n\n📎 Listen here:\n${asset.url}\n\n` +
      `What would you like to do next?`,
      [{ label: "⬇️ Save to device", value: `/downloadasset ${asset.id}` }, ...followUpButtons()]
    );
    return;
  }

  // visual — go straight to the remembered format if there is one, otherwise ask
  if (preferredFormat) {
    await deliverFormat(ctx, path, preferredFormat);
  } else {
    await sendFormatChoices(ctx, path);
  }
}

// shows a picker when a search resolves to more than one course, so a broad
// keyword (e.g. "Java" matches 4 unrelated courses) never silently serves a
// random one — each button pins the exact course via its slug
async function sendDisambiguationPicker(ctx, paths, label) {
  const rows = paths.map((path) => [{ label: path.title, value: `/openpath ${path.slug}` }]);
  rows.push([{ label: "▶️ Play all as a playlist", value: `/playlist ${label}::${paths.map((p) => p.slug).join(",")}` }]);

  await sendChoicesTracked(
    ctx,
    `I found ${paths.length} different courses for *${label}* — they're related but not the same thing. Which one did you mean?`,
    rows
  );
}

async function presentPaths(ctx, paths, notFoundLabel) {
  const { style, preferredFormat } = await getUserPreferences(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  if (paths.length === 0) {
    await ctx.sendText(
      `😕 I couldn't find anything on *${notFoundLabel}* right now.\n\n` +
      `Try a different topic, or type /suggest for an idea.`
    );
    return;
  }

  if (paths.length === 1) {
    await deliverForStyle(ctx, style, preferredFormat, paths[0]);
    return;
  }

  await sendDisambiguationPicker(ctx, paths, notFoundLabel);
}

async function handleTopicRequest(ctx, topic) {
  const paths = await findPathsByTopic(topic);
  await presentPaths(ctx, paths, topic);
}

async function handleRoleRequest(ctx, roleInput) {
  const role = matchRoleName(roleInput);
  if (!role) {
    await sendChoicesTracked(
      ctx,
      `I don't have a curriculum mapped for *${roleInput}* yet. Here are the roles I do know:`,
      Object.keys(ROLE_TOPIC_KEYWORDS).map((r) => [{ label: r, value: `/role ${r}` }])
    );
    return;
  }

  const paths = await findPathsByRole(role);
  await presentPaths(ctx, paths, role);
}

// ---------- playlists ----------

// button values for playlists carry an optional "label::slug,slug,..." shape
// so the delivered playlist message can show what it's actually a playlist
// of, instead of just a course count
function parseLabelAndSlugs(raw) {
  const sepIdx = raw.indexOf("::");
  const label = sepIdx >= 0 ? raw.slice(0, sepIdx) : null;
  const slugsPart = sepIdx >= 0 ? raw.slice(sepIdx + 2) : raw;
  const slugs = slugsPart.split(",").map((s) => s.trim()).filter(Boolean);
  return { label, slugs };
}

async function deliverPlaylist(ctx, slugs, label) {
  const { style, preferredFormat } = await getUserPreferences(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  const { data: matched, error } = await supabase
    .from("paths")
    .select("id, slug, title")
    .in("slug", slugs)
    .eq("is_published", true);

  if (error || !matched || matched.length === 0) {
    await ctx.sendText("😕 I couldn't find any of those courses anymore — try /findcourse to search again.");
    return;
  }
  const bySlug = new Map(matched.map((p) => [p.slug, p]));
  const paths = slugs.map((s) => bySlug.get(s)).filter(Boolean);
  const titleLine = label ? `🎵 *${label} playlist*\n\n` : "";

  if (style === "kinesthetic") {
    const lines = paths.map((p) => `🤸 *${p.title}*\n🔗 https://intellibus.academy/learning-paths/${p.slug}`);
    await sendChoicesTracked(
      ctx,
      `${titleLine}Here's the full list — you'll need to be logged into your Intellibus Academy account:\n\n${lines.join("\n\n")}\n\nWhat would you like to do next?`,
      followUpButtons()
    );
    return;
  }

  if (style === "audio") {
    await deliverPlaylistFormat(ctx, paths, "audio", label);
    return;
  }

  // visual
  if (preferredFormat && preferredFormat !== "slide_deck") {
    await deliverPlaylistFormat(ctx, paths, preferredFormat, label);
    return;
  }

  // no usable stored format yet (or it's slide_deck, which isn't
  // playlist-able — decks need their own per-slide navigation) — ask once
  const labelPart = label ? `${label}::` : "";
  await sendChoicesTracked(
    ctx,
    `${titleLine}Which format would you like this playlist in?`,
    [
      { label: "🖼️  Infographic", value: `/playlistformat infographic ${labelPart}${slugs.join(",")}` },
      { label: "🎬  Video",        value: `/playlistformat video ${labelPart}${slugs.join(",")}`       }
    ]
  );
}

async function deliverPlaylistFormat(ctx, paths, format, label) {
  if (format === "slide_deck") {
    // decks aren't playlist-able yet (nested slide navigation) — just hand
    // back the first course's deck and point at the picker for the rest
    await deliverFormat(ctx, paths[0], "slide_deck");
    return;
  }

  const assetType = format === "slide_deck" ? "deck" : format;
  const pathIds = paths.map((p) => p.id);

  const { data: rows, error } = await supabase
    .from("media_assets")
    .select("id, path_id, title, created_at")
    .in("path_id", pathIds)
    .eq("asset_type", assetType)
    .eq("is_published", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase playlist asset lookup failed:", error.message);
    await ctx.sendText("😕 Something went wrong building that playlist — try again in a moment.");
    return;
  }

  // one row per path (most recent if a path has duplicates), in the same
  // order as the resolved paths
  const byPath = new Map();
  for (const row of rows ?? []) if (!byPath.has(row.path_id)) byPath.set(row.path_id, row);
  const includedPaths = paths.filter((p) => byPath.has(p.id));
  const assetIds = includedPaths.map((p) => byPath.get(p.id).id);

  if (assetIds.length === 0) {
    await ctx.sendText(`😕 I couldn't find any ${format.replace("_", " ")} content for that set of courses yet.`);
    return;
  }

  // preferred_format only ever means "visual sub-format" (its check
  // constraint only allows infographic/video/slide_deck) — this function is
  // also used for the audio-style playlist path, which must not try to save
  // "audio" here or the upsert violates that constraint
  if (VISUAL_FORMATS.includes(format)) await setPreferredFormat(ctx.sender, format);

  const titleLine = label
    ? `🎵 *${label} playlist* — ${format.replace("_", " ")} (${assetIds.length} course${assetIds.length === 1 ? "" : "s"})\n\n`
    : `✅ Playlist ready — *${assetIds.length}* course${assetIds.length === 1 ? "" : "s"} queued up.\n\n`;
  const courseList = includedPaths.map((p, idx) => `${idx + 1}. ${p.title}`).join("\n");

  const buttons = format !== "video"
    ? [{ label: "⬇️ Save all to device", value: `/downloadplaylist ${assetIds.join(",")}` }, ...followUpButtons()]
    : followUpButtons();

  await sendChoicesTracked(
    ctx,
    `${titleLine}${courseList}\n\n` +
    `📎 Start here:\n${PUBLIC_BASE_URL}/playlist/${assetIds.join(",")}\n\n` +
    `What would you like to do next?`,
    buttons
  );
}

const bot = createAtlasBot({
  accessToken: process.env.ATLAS_BOT_TOKEN,
  instructions: `You are the Intellibus Academy Bot, a friendly and
  professional learning assistant for Intellibus Academy.
  Your job is to help users find training content on any topic, delivered
  in whatever way fits how they learn.
  Always greet warmly, then find out what topic, subject, or job role
  (e.g. UI Engineer, Backend Engineer, Full Stack Engineer, .NET Engineer,
  Project Manager, Data Engineer) they want to learn about, then call
  find_topic for a subject/topic or find_by_role for a job role.
  Never ask which format they want — the format is decided automatically
  by their stored learning style and past choices, not by you.`
});

// messages for a given room are dispatched strictly in order — if a handler
// ever hangs (e.g. a network call with no timeout of its own), every later
// message in that same room would silently queue up behind it forever, with
// no error and no reply, until the process restarts. This wraps every
// handler so a stuck call can't do that: past the timeout it gives up,
// apologizes, and lets the queue move on. onMessage gets a longer budget
// since ctx.think() legitimately can take up to ~2 minutes on its own.
const DEFAULT_HANDLER_TIMEOUT_MS = 20000;

function withTimeout(handler, ms = DEFAULT_HANDLER_TIMEOUT_MS) {
  return async (ctx) => {
    let timedOut = false;
    const timer = new Promise((resolve) => {
      const t = setTimeout(() => { timedOut = true; resolve(); }, ms);
      t.unref?.();
    });

    try {
      await Promise.race([handler(ctx), timer]);
    } catch (err) {
      console.error(`handler error: ${err.message}`);
      await ctx.sendText("😕 Something went wrong on my end — try that again in a moment.").catch(() => {});
      return;
    }

    if (timedOut) {
      console.error(`handler timed out after ${ms}ms`);
      await ctx.sendText("😕 That took too long to respond — try again in a moment.").catch(() => {});
    }
  };
}

function onCommand(name, handler) {
  bot.onCommand(name, withTimeout(handler));
}

function onMessage(handler, ms) {
  bot.onMessage(withTimeout(handler, ms));
}

// ---------- commands ----------

onCommand("start", async (ctx) => {
  const { style } = await getUserPreferences(ctx.sender);

  if (!style) {
    await promptLearningStyle(
      ctx,
      "👋 Welcome to Intellibus Academy! Before we start, how do you learn best?"
    );
    return;
  }

  await sendChoicesTracked(
    ctx,
    `👋 Welcome back! You're set up for *${style}* learning. What would you like to do?`,
    [
      { label: "🎓 Find course content",   value: "/findcourse" },
      { label: "💼 Search by job role",    value: "/role"       },
      { label: "💡 Suggest a topic",       value: "/suggest"    },
      { label: "🔀 Change learning style", value: "/style"      },
      { label: "❓ Help",                   value: "/help"       }
    ]
  );
});

onCommand("style", async (ctx) => {
  await promptLearningStyle(ctx, "How do you learn best?");
});

onCommand("setstyle", async (ctx) => {
  const style = ctx.args[0];

  if (!LEARNING_STYLES.includes(style)) {
    await ctx.sendText("Sorry, I didn't recognize that learning style. Type /style to try again.");
    return;
  }

  await setUserStyle(ctx.sender, style);

  const blurb = {
    audio:       "🎧 Got it — I'll go straight to audio content for whatever you want to learn.",
    visual:      "👀 Got it — I'll let you pick between infographics, videos, and slide decks the first time, then remember your favorite.",
    kinesthetic: "🤸 Got it — I'll point you to hands-on flashcards and quizzes on the Intellibus platform."
  }[style];

  await sendChoicesTracked(
    ctx,
    `${blurb}\n\nWhat would you like to learn about?`,
    [{ label: "🎓 Find course content", value: "/findcourse" }]
  );
});

onCommand("formats", async (ctx) => {
  const slug = ctx.argText.trim();
  const path = await findPathBySlug(slug);
  if (!path) {
    await ctx.sendText("Sorry, I lost track of what you were looking for. Type /findcourse to start again.");
    return;
  }
  await sendFormatChoices(ctx, path);
});

onCommand("openpath", async (ctx) => {
  const slug = ctx.argText.trim();
  const { style, preferredFormat } = await getUserPreferences(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }
  const path = await findPathBySlug(slug);
  if (!path) {
    await ctx.sendText("😕 That course doesn't seem to be available anymore. Try /findcourse to search again.");
    return;
  }
  await deliverForStyle(ctx, style, preferredFormat, path);
});

onCommand("playlist", async (ctx) => {
  const { label, slugs } = parseLabelAndSlugs(ctx.argText.trim());
  if (slugs.length === 0) {
    await ctx.sendText("Sorry, I lost track of what you were looking for. Type /findcourse to start again.");
    return;
  }
  await deliverPlaylist(ctx, slugs, label);
});

onCommand("playlistformat", async (ctx) => {
  const raw = ctx.argText.trim();
  const spaceIdx = raw.indexOf(" ");
  const format = spaceIdx >= 0 ? raw.slice(0, spaceIdx) : raw;
  const { label, slugs } = parseLabelAndSlugs(spaceIdx >= 0 ? raw.slice(spaceIdx + 1) : "");

  if (!VISUAL_FORMATS.includes(format) || slugs.length === 0) {
    await ctx.sendText("Sorry, I lost track of what you were looking for. Type /findcourse to start again.");
    return;
  }

  const { data: matched } = await supabase
    .from("paths")
    .select("id, slug, title")
    .in("slug", slugs)
    .eq("is_published", true);

  const bySlug = new Map((matched ?? []).map((p) => [p.slug, p]));
  const paths = slugs.map((s) => bySlug.get(s)).filter(Boolean);
  if (paths.length === 0) {
    await ctx.sendText("😕 I couldn't find any of those courses anymore — try /findcourse to search again.");
    return;
  }

  await deliverPlaylistFormat(ctx, paths, format, label);
});

onCommand("downloadasset", async (ctx) => {
  const assetId = ctx.argText.trim();
  const { data: asset, error } = await supabase
    .from("media_assets")
    .select("bucket, storage_path, mime_type, asset_type, title")
    .eq("id", assetId)
    .eq("is_published", true)
    .maybeSingle();

  if (error || !asset) {
    await ctx.sendText("😕 I couldn't find that content anymore.");
    return;
  }
  if (HLS_MIME_TYPES.has((asset.mime_type || "").toLowerCase())) {
    await ctx.sendText("😕 Video can't be sent as a direct file — it's streamed in many pieces, not one downloadable file. Use the link instead.");
    return;
  }
  if (asset.storage_path.endsWith("/")) {
    await ctx.sendText("😕 This slide deck is a set of separate slide images rather than one file — download individual slides from the deck viewer link instead.");
    return;
  }

  const result = await sendAssetAsAttachment(ctx, asset).catch((err) => {
    console.error("Failed to send asset attachment:", err.message);
    return { sent: false, reason: "error" };
  });
  if (!result.sent) {
    await ctx.sendText(
      result.reason === "too_large"
        ? "😕 That file's too large to send directly here — use the link instead."
        : "😕 Something went wrong sending that file — try the link instead."
    );
  }
});

onCommand("downloadplaylist", async (ctx) => {
  const ids = ctx.argText.trim().split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    await ctx.sendText("Sorry, I lost track of that playlist. Try again from /findcourse.");
    return;
  }

  const { data: assets, error } = await supabase
    .from("media_assets")
    .select("id, bucket, storage_path, mime_type, asset_type, title")
    .in("id", ids)
    .eq("is_published", true);

  if (error || !assets || assets.length === 0) {
    await ctx.sendText("😕 I couldn't find that playlist's content anymore.");
    return;
  }

  const byId = new Map(assets.map((a) => [a.id, a]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  if (HLS_MIME_TYPES.has((ordered[0]?.mime_type || "").toLowerCase())) {
    await ctx.sendText("😕 Video can't be sent as direct files — they're streamed in many pieces, not one downloadable file each. Use the playlist link instead.");
    return;
  }

  await ctx.sendText(`⬇️ Sending ${ordered.length} file${ordered.length === 1 ? "" : "s"} to you now — this'll take a few seconds...`);

  let sentCount = 0;
  let tooLargeCount = 0;
  for (const asset of ordered) {
    const result = await sendAssetAsAttachment(ctx, asset).catch((err) => {
      console.error(`Failed to send playlist asset ${asset.id}:`, err.message);
      return { sent: false, reason: "error" };
    });
    if (result.sent) sentCount++;
    else if (result.reason === "too_large") tooLargeCount++;
    // the SDK enforces a 1s per-room send cooldown — space these out so
    // later files in the playlist aren't silently dropped by it
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }

  const skippedNote = tooLargeCount > 0 ? ` (${tooLargeCount} skipped — too large to send directly, use the playlist link for those)` : "";
  await ctx.sendText(
    sentCount > 0
      ? `✅ Sent ${sentCount} of ${ordered.length} file${ordered.length === 1 ? "" : "s"}${skippedNote}.`
      : "😕 Something went wrong sending those files — try the playlist link instead."
  );
});

onCommand("role", async (ctx) => {
  const roleInput = ctx.argText.trim();

  if (!roleInput) {
    await sendChoicesTracked(
      ctx,
      "Which job role would you like course recommendations for?",
      Object.keys(ROLE_TOPIC_KEYWORDS).map((r) => [{ label: r, value: `/role ${r}` }])
    );
    return;
  }

  await handleRoleRequest(ctx, roleInput);
});

onCommand("findcourse", async (ctx) => {
  const { style } = await getUserPreferences(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  await ctx.sendText(
    "What topic, subject, or job role would you like to learn about?\n\n" +
    "For example: *Project Management*, *Python Programming*, or *Backend Engineer*"
  );
});

onCommand("suggest", async (ctx) => {
  const { data: paths, error } = await supabase
    .from("paths")
    .select("id, slug, topic, title")
    .eq("is_published", true)
    .limit(50);

  if (error || !paths || paths.length === 0) {
    await ctx.sendText("I couldn't pull up any suggestions right now — try /findcourse with a topic you already have in mind.");
    return;
  }

  const pick = paths[Math.floor(Math.random() * paths.length)];
  await presentPaths(ctx, [pick], pick.topic);
});

const REMIND_DURATION_RE = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

function parseDurationMs(text) {
  const match = text.trim().match(REMIND_DURATION_RE);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const msPerUnit = unit.startsWith("m") ? 60000 : unit.startsWith("h") ? 3600000 : 86400000;
  return amount * msPerUnit;
}

function describeDelay(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3600000);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86400000);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

onCommand("remind", async (ctx) => {
  const raw = ctx.argText.trim();

  if (raw.toLowerCase() === "cancel") {
    await supabase.from("reminders").delete().eq("user_id", ctx.sender).eq("sent", false);
    await ctx.sendText("🔕 Cancelled your reminder.");
    return;
  }

  const inMatch = raw.match(/^(.*)\s+in\s+([\d\s\w]+)$/i);
  const delayMs = inMatch ? parseDurationMs(inMatch[2]) : null;
  const topic = inMatch && delayMs ? inMatch[1].trim() : raw;

  if (!topic) {
    await ctx.sendText(
      "Tell me what you'd like a reminder for, and optionally when:\n\n" +
      "`/remind CSS` — tomorrow\n" +
      "`/remind CSS in 30m` — in 30 minutes\n" +
      "`/remind CSS in 2h` — in 2 hours\n" +
      "`/remind cancel` — cancel your reminder\n\n" +
      "Run /remind again anytime to change the topic or time — it replaces your last one."
    );
    return;
  }

  if (inMatch && !delayMs) {
    await ctx.sendText(`😕 I didn't understand that time. Try something like \`/remind ${inMatch[1].trim()} in 30m\` or \`in 2h\`.`);
    return;
  }

  const delay = delayMs ?? 24 * 60 * 60 * 1000;
  const remindAt = new Date(Date.now() + delay);

  // one active reminder per user, enforced by a unique constraint on user_id
  // — upsert so re-running /remind atomically replaces the time/topic
  // instead of racing a separate delete+insert (which could leave two rows
  // if /remind was invoked twice in quick succession, each later firing its
  // own reminder — that looks exactly like a duplicated reminder message)
  const { error } = await supabase.from("reminders").upsert({
    user_id: ctx.sender,
    room_id: ctx.roomId,
    topic,
    remind_at: remindAt.toISOString(),
    sent: false
  }, { onConflict: "user_id" });

  if (error) {
    console.error("Supabase reminder insert failed:", error.message);
    await ctx.sendText("😕 Something went wrong scheduling that — try again in a moment.");
    return;
  }

  await ctx.sendText(`⏰ Done! I'll remind you ${describeDelay(delay)} to keep learning *${topic}*.`);
});

onCommand("help", async (ctx) => {
  await ctx.sendText(
    "Here's what I can do:\n\n" +
    "🔹 /findcourse — find training content on any topic\n" +
    "🔹 /role — get course recommendations for a job role\n" +
    "🔹 /style — change how content is delivered to you (audio, visual, or kinesthetic)\n" +
    "🔹 /suggest — get a topic recommendation\n" +
    "🔹 /remind <topic> [in <time>] — get reminded to keep learning (defaults to tomorrow; try `in 30m` or `in 2h`; running it again changes the time)\n\n" +
    "Just tell me what you want to learn and I'll take it from there, tailored to how you learn best."
  );
});

// all other messages - handled by the platform LLM
onMessage(async (ctx) => {
  const { style } = await getUserPreferences(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  // set by any tool below that has already sent the user-facing reply
  // itself — the LLM's own trailing `reply` text would otherwise get sent
  // on top of that as a redundant, confusing second message
  let repliedDirectly = false;

  const turn = await ctx.think({
    tools: new Map([
      ["find_topic", {
        description: "Look up learning content once the user has named a topic or subject",
        parameters: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "The topic the user wants to learn about"
            }
          },
          required: ["topic"]
        },
        handler: async ({ topic }) => {
          await handleTopicRequest(ctx, topic);
          repliedDirectly = true;
          return { handled: true, topic };
        }
      }],
      ["find_by_role", {
        description: "Look up course recommendations once the user has named a job role instead of a specific topic",
        parameters: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The job role the user wants course recommendations for, e.g. 'Backend Engineer'"
            }
          },
          required: ["role"]
        },
        handler: async ({ role }) => {
          await handleRoleRequest(ctx, role);
          repliedDirectly = true;
          return { handled: true, role };
        }
      }]
    ])
  });

  if (!repliedDirectly && turn.reply) await ctx.sendText(turn.reply);
}, 150000); // headroom above ctx.think()'s own ~120s internal timeout

// this is the /getformat command - it fires when a visual-style user taps a format button
onCommand("getformat", async (ctx) => {
  const [format, slug] = ctx.args;

  if (!format || !slug) {
    await ctx.sendText("Sorry, I lost track of what you were looking for. Type /findcourse to start again.");
    return;
  }

  const path = await findPathBySlug(slug);
  if (!path) {
    await ctx.sendText("😕 That course doesn't seem to be available anymore. Try /findcourse to search again.");
    return;
  }

  await deliverFormat(ctx, path, format);
});

// ---------- reminder delivery ----------
// self-contained: polls the reminders table and sends due ones directly via
// bot.sendText, which already goes through the same notify() pipeline every
// other reply uses to trigger a push notification — no external scheduler
// service required
const REMINDER_POLL_INTERVAL_MS = 30000;
let reminderPollInFlight = false;

async function checkDueReminders() {
  if (reminderPollInFlight) return;
  reminderPollInFlight = true;

  try {
    const { data: due, error } = await supabase
      .from("reminders")
      .select("id, user_id, room_id, topic")
      .eq("sent", false)
      .lte("remind_at", new Date().toISOString())
      .limit(50);

    if (error) {
      console.error("Supabase reminder poll failed:", error.message);
      return;
    }

    for (const reminder of due ?? []) {
      // claim it first (only if still unsent) so a slow send or an
      // overlapping tick can never deliver the same reminder twice
      const { data: claimed, error: claimError } = await supabase
        .from("reminders")
        .update({ sent: true })
        .eq("id", reminder.id)
        .eq("sent", false)
        .select("id");

      if (claimError) {
        console.error(`Failed to claim reminder ${reminder.id}:`, claimError.message);
        continue;
      }
      if (!claimed || claimed.length === 0) continue; // already claimed elsewhere

      try {
        await bot.sendText(reminder.room_id, `⏰ *Reminder:* time to continue with *${reminder.topic}* on Intellibus Academy!`);
      } catch (err) {
        console.error(`Failed to deliver reminder ${reminder.id}:`, err.message);
      }

      // clean up rather than leaving sent:true rows around — also means the
      // unique user_id constraint doesn't block their next /remind
      await supabase.from("reminders").delete().eq("id", reminder.id);
    }
  } finally {
    reminderPollInFlight = false;
  }
}

setInterval(() => {
  checkDueReminders().catch((err) => console.error("Reminder poll error:", err.message));
}, REMINDER_POLL_INTERVAL_MS);

bot.start();
console.log("Intellibus Academy Bot is running...");
