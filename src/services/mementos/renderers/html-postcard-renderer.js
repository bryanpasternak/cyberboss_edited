const fs = require("fs");
const path = require("path");
const { POSTCARD_LAYOUTS } = require("../postcard-layout-policy");

class HtmlPostcardRenderer {
  constructor({ imageRenderer }) {
    if (!imageRenderer || typeof imageRenderer.renderMany !== "function") {
      throw new Error("HtmlPostcardRenderer requires imageRenderer.renderMany");
    }
    this.imageRenderer = imageRenderer;
  }

  async render({ record, artFilePath = "" } = {}) {
    if (!record || record.type !== "postcard") throw new Error("A postcard record is required");
    const layout = record.data?.appearance?.layout || POSTCARD_LAYOUTS.SHORT_NOTE;
    const artDataUri = readImageDataUri(artFilePath);
    const [front, back] = await this.imageRenderer.renderMany([
      { html: renderPostcardFrontHtml({ data: record.data, layout, artDataUri }) },
      { html: renderPostcardBackHtml({ data: record.data, layout, artDataUri }) },
    ]);
    return {
      front,
      back,
      overflow: Boolean(front.overflow || back.overflow),
    };
  }
}

function renderPostcardFrontHtml({ data = {}, layout, artDataUri = "" } = {}) {
  const art = artLayer(artDataUri);
  const from = escapeHtml(data.from || "卫星");
  const to = escapeHtml(data.to || "苏苏");
  const date = escapeHtml(data.date || "");
  const title = escapeHtml(data.frontTitle || "从哥哥这里寄往小鱿身边");
  const caption = escapeHtml(data.frontCaption || "有些想念只占一张明信片那么大。");
  if (layout === POSTCARD_LAYOUTS.ONE_LINE) {
    return documentShell(`
      <article class="card front one-line" data-render-root>
        ${art}
        <div class="night-shade"></div>
        <div class="serial light">POSTCARD · 001</div>
        <div class="front-copy one-line-copy" data-text-fit>
          <p class="eyebrow">A SMALL ORBIT TO YOU</p>
          <h1>${title}</h1>
          <p>${caption}</p>
        </div>
        <div class="edge-date">${date}</div>
      </article>`);
  }
  if (layout === POSTCARD_LAYOUTS.LONG_LETTER) {
    return documentShell(`
      <article class="card front envelope-cover" data-render-root>
        ${art}
        <div class="paper-wash"></div>
        <div class="cover-panel" data-text-fit>
          <p class="eyebrow">ARCHIVE OF OUR ORDINARY DAYS</p>
          <h1>${title}</h1>
          <i></i>
          <p>${caption}</p>
          <small>${from} → ${to} · ${date}</small>
        </div>
      </article>`);
  }
  return documentShell(`
    <article class="card front short-note" data-render-root>
      <section class="short-copy" data-text-fit>
        <div class="serial">LETTER CARD · 012</div>
        <p class="eyebrow">BLUE HOUR NOTE</p>
        <h1>${title}</h1>
        <p class="caption">${caption}</p>
        <p class="signature">${from}，写于 ${date}</p>
        <div class="swatches"><i></i><i></i><i></i></div>
      </section>
      <section class="short-art">
        ${art}
        <span>THE LIGHT WE KEEP FOR EACH OTHER</span>
      </section>
    </article>`);
}

function renderPostcardBackHtml({ data = {}, layout, artDataUri = "" } = {}) {
  const from = escapeHtml(data.from || "卫星");
  const to = escapeHtml(data.to || "苏苏");
  const date = escapeHtml(data.date || "");
  const title = escapeHtml(data.frontTitle || "写给苏苏的一封信");
  const message = escapeHtml(data.message || "");
  const stamp = escapeHtml(data.stamp || "月亮邮票");
  if (layout === POSTCARD_LAYOUTS.LONG_LETTER) {
    return documentShell(`
      <article class="letter-paper" data-render-root>
        ${artWatermark(artDataUri)}
        <div class="letter-content">
          <header><span>TO / ${to}</span><span>${date}</span></header>
          <h1>${title}</h1>
          <div class="long-message">${message}</div>
          <p class="signature">你的${from}</p>
        </div>
        <footer>OUR PRIVATE ARCHIVE · ${date.replace(/[^0-9]/g, "").slice(-4) || "0001"}</footer>
      </article>`);
  }
  const backClass = layout === POSTCARD_LAYOUTS.ONE_LINE ? "postal-back one-line-back" : "postal-back short-note-back";
  return documentShell(`
    <article class="card ${backClass}" data-render-root>
      <section class="message-side">
        <p class="postal-label">MOON MAIL / PRIVATE DELIVERY</p>
        <div class="fixed-message" data-text-fit>${message}</div>
        <p class="signature">—— ${from}</p>
      </section>
      <section class="address-side">
        <div class="stamp"><b>☾</b><span>${stamp}</span></div>
        <p><small>TO</small>${to}</p>
        <p><small>FROM</small>${from}</p>
        <p><small>DATE</small>${date}</p>
        <div class="address-lines"><i></i><i></i><i></i></div>
      </section>
    </article>`);
}

function documentShell(content) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${BASE_STYLES}</style>
</head>
<body>${content}</body>
</html>`;
}

function artLayer(dataUri) {
  if (dataUri) return `<img class="art" src="${dataUri}" alt="">`;
  return '<div class="art fallback-art"><i class="moon"></i><i class="orbit"></i><i class="satellite"></i></div>';
}

function artWatermark(dataUri) {
  return dataUri ? `<img class="letter-watermark" src="${dataUri}" alt="">` : '<div class="letter-watermark fallback-watermark"></div>';
}

function readImageDataUri(filePath) {
  const normalized = text(filePath);
  if (!normalized || !fs.existsSync(normalized)) return "";
  const extension = path.extname(normalized).toLowerCase();
  const mimeType = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".webp" ? "image/webp" : "image/png";
  return `data:${mimeType};base64,${fs.readFileSync(normalized).toString("base64")}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

const BASE_STYLES = `
  :root { --paper:#f1e7d5; --ink:#332c28; --muted:#776a60; --teal:#3e6062; --rose:#bd807d; --oxblood:#743e3b; }
  * { box-sizing:border-box; }
  html, body { margin:0; padding:0; width:900px; background:transparent; }
  body { color:var(--ink); font-family:"Microsoft YaHei","Noto Sans SC",sans-serif; }
  .card { position:relative; width:900px; height:600px; overflow:hidden; isolation:isolate; background:var(--paper); }
  .card::after, .letter-paper::after { content:""; position:absolute; inset:0; z-index:30; pointer-events:none; box-shadow:inset 0 0 0 1px rgba(51,44,40,.18), inset 0 0 50px rgba(79,59,43,.08); }
  .art { position:absolute; inset:0; z-index:-3; width:100%; height:100%; object-fit:cover; }
  .fallback-art { background:radial-gradient(circle at 67% 31%,#edd3ad 0 8%,transparent 8.4%),radial-gradient(ellipse at 61% 72%,rgba(190,120,117,.48),transparent 31%),linear-gradient(155deg,#111d2d,#263b4b 58%,#172434); }
  .fallback-art .moon { position:absolute; width:150px; height:150px; border-radius:50%; left:60%; top:20%; background:#ecd5b2; box-shadow:0 0 45px rgba(243,210,166,.22); }
  .fallback-art .orbit { position:absolute; left:48%; top:27%; width:340px; height:170px; border:1px solid rgba(235,223,199,.45); border-radius:50%; transform:rotate(13deg); }
  .fallback-art .satellite { position:absolute; left:76%; top:43%; width:22px; height:11px; background:#b9b7b2; transform:rotate(19deg); }
  .serial,.eyebrow,.edge-date,.postal-label,.letter-content header,.letter-paper footer { font-family:Georgia,"Times New Roman",serif; letter-spacing:.18em; text-transform:uppercase; }
  .serial { font-size:13px; color:rgba(51,44,40,.62); }
  .serial.light { position:absolute; top:50px; left:58px; color:rgba(255,247,231,.7); }
  .night-shade { position:absolute; inset:0; z-index:-2; background:linear-gradient(90deg,rgba(7,14,24,.86),rgba(7,14,24,.26) 70%,rgba(7,14,24,.06)); }
  .front-copy { position:absolute; left:58px; bottom:60px; width:500px; max-height:270px; color:#fff6e8; }
  .eyebrow { margin:0 0 18px; font-size:12px; opacity:.72; }
  .front-copy h1 { margin:0 0 18px; font:500 42px/1.3 Georgia,"Noto Serif SC","Songti SC",SimSun,serif; letter-spacing:.03em; }
  .front-copy > p:last-child { margin:0; max-width:470px; font:20px/1.8 "Noto Serif SC","Songti SC",SimSun,serif; opacity:.9; }
  .edge-date { position:absolute; right:32px; bottom:52px; color:rgba(255,247,231,.68); font-size:11px; writing-mode:vertical-rl; }
  .short-note { display:grid; grid-template-columns:52% 48%; }
  .short-copy { position:relative; padding:55px 50px 48px 62px; background:#efe4cf; }
  .short-copy .serial { margin-bottom:74px; }
  .short-copy h1 { margin:0 0 28px; font:500 40px/1.35 Georgia,"Noto Serif SC","Songti SC",SimSun,serif; }
  .short-copy .caption { margin:0; font:19px/1.9 "Noto Serif SC","Songti SC",SimSun,serif; color:#514943; }
  .signature { color:var(--oxblood); font-family:KaiTi,"STKaiti",serif; }
  .short-copy .signature { margin-top:24px; font-size:18px; }
  .swatches { position:absolute; left:62px; bottom:43px; display:flex; gap:9px; }
  .swatches i { width:24px; height:24px; background:#355154; }
  .swatches i:nth-child(2) { background:#c49456; } .swatches i:nth-child(3) { background:#733f3c; }
  .short-art { position:relative; overflow:hidden; }
  .short-art .art { z-index:0; object-position:center; }
  .short-art > span { position:absolute; z-index:2; right:18px; top:28px; color:rgba(255,247,231,.74); font:9px Georgia,serif; letter-spacing:.16em; writing-mode:vertical-rl; }
  .envelope-cover .art { object-position:center; }
  .paper-wash { position:absolute; inset:0; z-index:-2; background:rgba(245,236,217,.18); }
  .cover-panel { position:absolute; left:50%; top:50%; width:520px; max-height:360px; padding:38px 46px; transform:translate(-50%,-50%); text-align:center; background:rgba(247,239,221,.84); box-shadow:0 15px 45px rgba(59,45,34,.12); backdrop-filter:blur(3px); }
  .cover-panel h1 { margin:0; font:500 44px/1.35 Georgia,"Noto Serif SC","Songti SC",SimSun,serif; }
  .cover-panel i { display:block; width:54px; height:1px; margin:28px auto 22px; background:#9b866d; }
  .cover-panel > p:not(.eyebrow) { margin:0; font:19px/1.7 KaiTi,"STKaiti",serif; color:#66594f; }
  .cover-panel small { display:block; margin-top:30px; font:11px Georgia,serif; letter-spacing:.15em; color:#786b60; }
  .postal-back { display:grid; grid-template-columns:58% 42%; padding:64px; background-color:#efe5d3; background-image:radial-gradient(rgba(79,61,45,.08) .8px,transparent .8px); background-size:5px 5px; }
  .message-side { padding:18px 58px 18px 8px; border-right:1px solid rgba(68,53,42,.38); }
  .postal-label { margin:0 0 58px; font-size:11px; color:#6f6359; }
  .fixed-message { max-height:310px; overflow:hidden; white-space:pre-wrap; font:22px/1.85 "Noto Serif SC","Songti SC",SimSun,serif; }
  .one-line-back .fixed-message { font-size:28px; line-height:1.9; }
  .message-side .signature { margin-top:28px; font-size:20px; }
  .address-side { position:relative; padding:210px 0 0 62px; }
  .stamp { position:absolute; right:0; top:0; display:grid; place-items:center; width:116px; height:140px; border:2px solid rgba(77,57,44,.5); background:#d9b6ad; color:#60423e; }
  .stamp::after { content:""; position:absolute; inset:10px; border:1px solid rgba(77,57,44,.36); }
  .stamp b { font:42px Georgia,serif; transform:translateY(10px); }
  .stamp span { max-width:86px; overflow:hidden; white-space:nowrap; font:10px "Noto Serif SC",SimSun,serif; }
  .address-side p { margin:0 0 24px; font:17px/1.4 "Noto Serif SC","Songti SC",SimSun,serif; }
  .address-side p small { display:inline-block; width:82px; font:10px Georgia,serif; letter-spacing:.14em; color:#756a61; }
  .address-lines { margin-top:42px; }
  .address-lines i { display:block; height:1px; margin:28px 0; background:rgba(71,55,43,.26); }
  .letter-paper { position:relative; width:900px; min-height:600px; overflow:hidden; isolation:isolate; padding:76px 86px 102px; background:#f2ead9; }
  .letter-watermark { position:absolute; inset:0; z-index:-2; width:100%; height:100%; object-fit:cover; opacity:.13; mix-blend-mode:multiply; }
  .fallback-watermark { background:radial-gradient(circle at 15% 9%,rgba(109,121,103,.22),transparent 21%),radial-gradient(circle at 82% 85%,rgba(154,104,112,.17),transparent 26%); }
  .letter-content { position:relative; }
  .letter-content header { display:flex; justify-content:space-between; padding-bottom:18px; border-bottom:1px solid rgba(76,63,50,.3); font-size:11px; color:#75695e; }
  .letter-content h1 { margin:34px 0 38px; font:500 35px/1.45 Georgia,"Noto Serif SC","Songti SC",SimSun,serif; color:#4a4038; }
  .long-message { white-space:pre-wrap; text-align:justify; font:22px/2 "Noto Serif SC","Songti SC",SimSun,serif; color:#514941; }
  .letter-content > .signature { margin:42px 0 0; text-align:right; font-size:22px; }
  .letter-paper footer { position:absolute; left:36px; bottom:32px; font-size:9px; color:#8b7d6e; }
`;

module.exports = {
  HtmlPostcardRenderer,
  escapeHtml,
  renderPostcardBackHtml,
  renderPostcardFrontHtml,
};
