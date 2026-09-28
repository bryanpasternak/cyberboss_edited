function paragraphText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String(value.text || "");
  return "";
}

function paragraphKind(value) {
  if (typeof value === "string") return "text";
  if (value && typeof value === "object") return String(value.kind || "rich");
  return "text";
}

function isRichParagraph(value) {
  return Boolean(value && typeof value === "object" && paragraphKind(value) !== "text");
}

module.exports = { paragraphText, paragraphKind, isRichParagraph };
