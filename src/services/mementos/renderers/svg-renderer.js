function renderCard({ eyebrow = "", title = "", lines = [], footer = "", palette = {} } = {}) {
  const colors = {
    background: palette.background || "#f5efe6",
    panel: palette.panel || "#fffaf2",
    ink: palette.ink || "#3c302d",
    accent: palette.accent || "#9a5b69",
  };
  const bodyLines = lines.flatMap((line) => wrapText(String(line || ""), 26)).slice(0, 12);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">',
    `<rect width="900" height="600" rx="36" fill="${colors.background}"/>`,
    `<rect x="46" y="46" width="808" height="508" rx="28" fill="${colors.panel}" stroke="${colors.accent}" stroke-width="3"/>`,
    `<text x="90" y="112" font-family="sans-serif" font-size="24" fill="${colors.accent}" letter-spacing="3">${escapeXml(eyebrow)}</text>`,
    `<text x="90" y="174" font-family="serif" font-size="46" font-weight="700" fill="${colors.ink}">${escapeXml(title)}</text>`,
    ...bodyLines.map((line, index) => `<text x="92" y="${240 + (index * 30)}" font-family="sans-serif" font-size="23" fill="${colors.ink}">${escapeXml(line)}</text>`),
    `<text x="90" y="520" font-family="serif" font-size="20" fill="${colors.accent}">${escapeXml(footer)}</text>`,
    "</svg>",
  ].join("\n");
}

function renderPostcardBack({ from, to, date, message, stamp }) {
  const messageLines = wrapText(message, 25).slice(0, 11);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">',
    '<rect width="900" height="600" fill="#f4ead8"/>',
    '<rect x="35" y="35" width="830" height="530" fill="none" stroke="#9b7862" stroke-width="3"/>',
    '<line x1="500" y1="80" x2="500" y2="520" stroke="#bfa58e" stroke-width="2"/>',
    ...messageLines.map((line, index) => `<text x="75" y="${120 + (index * 34)}" font-family="serif" font-size="25" fill="#493c35">${escapeXml(line)}</text>`),
    `<rect x="720" y="75" width="95" height="115" fill="#d9b7bd" stroke="#8e5966" stroke-width="3"/>`,
    `<text x="768" y="125" text-anchor="middle" font-family="serif" font-size="18" fill="#6f3e49">${escapeXml(stamp || "月亮邮票")}</text>`,
    `<text x="550" y="260" font-family="sans-serif" font-size="23" fill="#493c35">收件人：${escapeXml(to)}</text>`,
    `<text x="550" y="310" font-family="sans-serif" font-size="23" fill="#493c35">寄件人：${escapeXml(from)}</text>`,
    `<text x="550" y="360" font-family="sans-serif" font-size="23" fill="#493c35">日期：${escapeXml(date)}</text>`,
    "</svg>",
  ].join("\n");
}

function wrapText(value, limit) {
  const chars = Array.from(String(value || ""));
  const lines = [];
  for (let index = 0; index < chars.length; index += limit) lines.push(chars.slice(index, index + limit).join(""));
  return lines.length ? lines : [""];
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { renderCard, renderPostcardBack, escapeXml, wrapText };
