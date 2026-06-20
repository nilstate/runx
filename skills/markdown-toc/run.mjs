import fs from "node:fs";

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function isInsideCodeBlock(lines, index) {
  let codeBlock = false;
  for (let i = 0; i < index; i++) {
    if (lines[i].trimStart().startsWith("```")) codeBlock = !codeBlock;
  }
  return codeBlock;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "heading";
}

function parseHeadings(markdown) {
  const lines = markdown.split("\n");
  const counts = {};
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (isInsideCodeBlock(lines, i)) continue;
    const match = lines[i].match(/^(#{1,5})\s+(.+)$/);
    if (!match) continue;
    let text = match[2].trim().replace(/\s*\{#[^}]+\}\s*$/, "").trim();
    const anchor = slugify(text);
    counts[anchor] = (counts[anchor] || 0) + 1;
    const uniqueAnchor = counts[anchor] > 1 ? `${anchor}-${counts[anchor] - 1}` : anchor;
    result.push({ level: match[1].length, text, anchor: uniqueAnchor });
  }
  return result;
}

const inputs = readInputs();
const toc = parseHeadings(inputs.content || "");
process.stdout.write(JSON.stringify(toc, null, 2) + "\n");
