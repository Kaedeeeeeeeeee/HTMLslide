import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsRoot = path.join(root, "docs");
const outputRoot = path.join(root, "dist", "docs-site");
const repositoryUrl = process.env.HTMLSLIDE_REPOSITORY_URL ?? "https://github.com/Kaedeeeeeeeeee/HTMLslide";

const sidebarSections = [
  {
    title: "Start Here",
    links: [
      ["Introduction", "index.md"],
      ["Install", "install.md"],
      ["Getting Started", "getting-started.md"],
      ["First Deck", "create-your-first-deck.md"],
      ["Troubleshooting", "troubleshooting.md"]
    ]
  },
  {
    title: "AI Modes",
    links: [
      ["No AI", "getting-started.md#no-ai-path"],
      ["BYOK", "byok.md"],
      ["AI Engines", "ai-engines.md"],
      ["Claude Code", "connect-claude-code.md"],
      ["Codex", "connect-codex.md"]
    ]
  },
  {
    title: "Product Surfaces",
    links: [
      ["Project Structure", "project-structure.md"],
      ["CLI", "cli.md"],
      ["MCP", "mcp.md"],
      ["Skills", "skills.md"],
      ["Design Skills", "design-skills.md"],
      ["Exporting", "exporting.md"],
      ["Presenter Mode", "presenter-mode.md"]
    ]
  },
  {
    title: "Contributors",
    links: [
      ["Contributing", "contributing.md"],
      ["Testing", "testing.md"],
      ["Release", "release.md"],
      ["Security", "security.md"]
    ]
  },
  {
    title: "Developer Reference",
    links: [
      ["Dev Testing", "dev/testing.md"],
      ["Dev Release", "dev/release.md"],
      ["Deck Spec", "spec/deck.md"],
      ["CLI Spec", "spec/cli.md"],
      ["Export Spec", "spec/export.md"],
      ["Agent Spec", "spec/agent.md"],
      ["Skills Spec", "spec/skills.md"]
    ]
  }
];

function toPosixPath(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function slugify(value) {
  return value
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");
}

function markdownOutputPath(relativePath) {
  const parsed = path.posix.parse(relativePath);
  if (parsed.base.toLowerCase() === "readme.md") {
    return path.posix.join(parsed.dir, "index.html");
  }
  if (relativePath === "index.md") {
    return "index.html";
  }
  return path.posix.join(parsed.dir, `${parsed.name}.html`);
}

function splitTarget(rawTarget) {
  const trimmed = rawTarget.trim().replace(/^<(.+)>$/u, "$1");
  const destination = trimmed.replace(/\s+["'][^"']*["']\s*$/u, "");
  const hashIndex = destination.indexOf("#");
  const queryIndex = destination.indexOf("?");
  const splitIndex = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;

  if (splitIndex === -1) {
    return { pathPart: destination, suffix: "" };
  }

  return {
    pathPart: destination.slice(0, splitIndex),
    suffix: destination.slice(splitIndex)
  };
}

function relativeUrl(fromOutputPath, toOutputPath) {
  const fromDir = path.posix.dirname(fromOutputPath);
  const relative = path.posix.relative(fromDir === "." ? "" : fromDir, toOutputPath);
  return relative || path.posix.basename(toOutputPath);
}

function isExternalUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
}

function rewriteUrl(rawTarget, sourceRelativePath) {
  const { pathPart, suffix } = splitTarget(rawTarget);

  if (!pathPart || pathPart.startsWith("#") || isExternalUrl(pathPart)) {
    return rawTarget;
  }

  const sourceDir = path.dirname(path.join(docsRoot, sourceRelativePath));
  const targetAbsolute = path.resolve(sourceDir, pathPart);
  const sourceOutputPath = markdownOutputPath(sourceRelativePath);

  if (isInside(targetAbsolute, docsRoot)) {
    const targetRelativePath = toPosixPath(path.relative(docsRoot, targetAbsolute));
    const outputTarget = targetRelativePath.endsWith(".md")
      ? markdownOutputPath(targetRelativePath)
      : targetRelativePath;
    return `${relativeUrl(sourceOutputPath, outputTarget)}${suffix}`;
  }

  if (isInside(targetAbsolute, root)) {
    const repositoryPath = toPosixPath(path.relative(root, targetAbsolute));
    return `${repositoryUrl}/blob/main/${repositoryPath}${suffix}`;
  }

  return rawTarget;
}

function rewriteDocsRootUrl(rawTarget, sourceRelativePath) {
  const { pathPart, suffix } = splitTarget(rawTarget);

  if (!pathPart || pathPart.startsWith("#") || isExternalUrl(pathPart)) {
    return rawTarget;
  }

  const targetAbsolute = path.resolve(docsRoot, pathPart);
  const sourceOutputPath = markdownOutputPath(sourceRelativePath);

  if (isInside(targetAbsolute, docsRoot)) {
    const targetRelativePath = toPosixPath(path.relative(docsRoot, targetAbsolute));
    const outputTarget = targetRelativePath.endsWith(".md")
      ? markdownOutputPath(targetRelativePath)
      : targetRelativePath;
    return `${relativeUrl(sourceOutputPath, outputTarget)}${suffix}`;
  }

  return rawTarget;
}

function renderInline(markdown, sourceRelativePath) {
  const tokens = [];
  const pushToken = (html) => {
    const token = `HTMLSLIDE_TOKEN_${tokens.length}_END`;
    tokens.push([token, html]);
    return token;
  };

  let text = markdown.replace(/`([^`]+)`/gu, (_match, code) => pushToken(`<code>${escapeHtml(code)}</code>`));

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, (_match, alt, target) => {
    const src = rewriteUrl(target, sourceRelativePath);
    return pushToken(`<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy">`);
  });

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (_match, label, target) => {
    const href = rewriteUrl(target, sourceRelativePath);
    const isExternal = isExternalUrl(href);
    const targetAttrs = isExternal ? ' target="_blank" rel="noreferrer"' : "";
    return pushToken(`<a href="${escapeAttribute(href)}"${targetAttrs}>${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/gu, "<em>$1</em>");

  for (const [token, html] of tokens) {
    text = text.replaceAll(token, html);
  }

  return text;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function renderTable(rows, sourceRelativePath) {
  const [head = [], , ...body] = rows;
  const headHtml = head
    .map((cell) => `<th>${renderInline(cell, sourceRelativePath)}</th>`)
    .join("");
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, sourceRelativePath)}</td>`).join("")}</tr>`)
    .join("\n");

  return `<div class="table-scroll"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderMarkdown(markdown, sourceRelativePath) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html = [];
  const headings = [];
  let paragraph = [];
  let listType = null;
  let inCodeFence = false;
  let codeFenceLanguage = "";
  let codeLines = [];

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInline(paragraph.join(" "), sourceRelativePath)}</p>`);
    paragraph = [];
  }

  function closeList() {
    if (!listType) {
      return;
    }
    html.push(`</${listType}>`);
    listType = null;
  }

  function openList(nextType) {
    flushParagraph();
    if (listType === nextType) {
      return;
    }
    closeList();
    listType = nextType;
    html.push(`<${listType}>`);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (inCodeFence) {
      if (/^```/u.test(line)) {
        html.push(
          `<pre><code${codeFenceLanguage ? ` class="language-${escapeAttribute(codeFenceLanguage)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
        );
        inCodeFence = false;
        codeFenceLanguage = "";
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const codeFenceMatch = line.match(/^```\s*([A-Za-z0-9_-]+)?\s*$/u);
    if (codeFenceMatch) {
      flushParagraph();
      closeList();
      inCodeFence = true;
      codeFenceLanguage = codeFenceMatch[1] ?? "";
      codeLines = [];
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    if (line.trim().startsWith("|") && isTableSeparator(lines[index + 1] ?? "")) {
      flushParagraph();
      closeList();
      const rows = [splitTableRow(line), splitTableRow(lines[index + 1] ?? "")];
      index += 2;
      while (index < lines.length && lines[index]?.trim().startsWith("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      html.push(renderTable(rows, sourceRelativePath));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/u);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const id = slugify(headingText);
      headings.push({ id, level, text: headingText });
      html.push(`<h${level} id="${escapeAttribute(id)}">${renderInline(headingText, sourceRelativePath)}</h${level}>`);
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/u);
    if (unorderedMatch) {
      openList("ul");
      html.push(`<li>${renderInline(unorderedMatch[1], sourceRelativePath)}</li>`);
      continue;
    }

    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/u);
    if (orderedMatch) {
      openList("ol");
      html.push(`<li>${renderInline(orderedMatch[1], sourceRelativePath)}</li>`);
      continue;
    }

    const blockquoteMatch = line.match(/^\s*>\s+(.+)$/u);
    if (blockquoteMatch) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(blockquoteMatch[1], sourceRelativePath)}</blockquote>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();

  if (inCodeFence) {
    html.push(
      `<pre><code${codeFenceLanguage ? ` class="language-${escapeAttribute(codeFenceLanguage)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
    );
  }

  return {
    body: html.join("\n"),
    headings
  };
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function pageTitle(markdown, relativePath) {
  const heading = markdown.match(/^#\s+(.+)$/mu);
  if (heading) {
    return heading[1].trim();
  }
  return path.posix.basename(relativePath, ".md");
}

function pageDescription(title, relativePath) {
  if (relativePath === "index.md") {
    return "Public alpha documentation for HTMLslide, the local-first workbench for AI-agent-native HTML/PDF slide decks.";
  }
  return `${title} documentation for HTMLslide.`;
}

function buildSidebar(currentRelativePath) {
  return sidebarSections
    .map((section) => {
      const links = section.links
        .map(([label, target]) => {
          const targetPath = splitTarget(target).pathPart || "index.md";
          const active = currentRelativePath === targetPath || (currentRelativePath === "index.md" && targetPath === "index.md");
          return `<a class="sidebar-link${active ? " active" : ""}" href="${escapeAttribute(rewriteDocsRootUrl(target, currentRelativePath))}">${escapeHtml(label)}</a>`;
        })
        .join("\n");
      return `<section class="sidebar-section"><h2>${escapeHtml(section.title)}</h2>${links}</section>`;
    })
    .join("\n");
}

function buildToc(headings) {
  const items = headings
    .filter((heading) => heading.level >= 2 && heading.level <= 3)
    .map((heading) => {
      const className = heading.level === 3 ? "toc-link nested" : "toc-link";
      return `<a class="${className}" href="#${escapeAttribute(heading.id)}">${escapeHtml(heading.text)}</a>`;
    });

  if (items.length === 0) {
    return '<p class="toc-empty">No sections</p>';
  }

  return items.join("\n");
}

function homePipeline(relativePath) {
  if (relativePath !== "index.md") {
    return "";
  }

  return `<section class="pipeline" aria-label="HTMLslide build pipeline">
  <div class="pipeline-stage">
    <span class="stage-label">Slide source</span>
    <strong>HTML / Markdown</strong>
    <code>slides/ + notes/ + assets/</code>
  </div>
  <span class="pipeline-arrow" aria-hidden="true">-></span>
  <div class="pipeline-stage">
    <span class="stage-label">Compiler</span>
    <strong>Check and export</strong>
    <code>htmlslide check && export</code>
  </div>
  <span class="pipeline-arrow" aria-hidden="true">-></span>
  <div class="pipeline-stage">
    <span class="stage-label">Outputs</span>
    <strong>PDF / deckpkg</strong>
    <code>Presenter-ready artifacts</code>
  </div>
</section>`;
}

function layout({ body, currentRelativePath, description, headings, title }) {
  const sidebar = buildSidebar(currentRelativePath);
  const toc = buildToc(headings);
  const pipeline = homePipeline(currentRelativePath);
  const faviconUrl = relativeUrl(markdownOutputPath(currentRelativePath), "favicon.svg");
  const articleBody = pipeline
    ? body.replace(/(<h1\b[^>]*>[\s\S]*?<\/h1>)/u, `$1\n${pipeline}`)
    : body;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeAttribute(description)}">
  <link rel="icon" href="${escapeAttribute(faviconUrl)}" type="image/svg+xml">
  <title>${escapeHtml(title)} | HTMLslide</title>
  <style>
    :root {
      color-scheme: light;
      --background: #ffffff;
      --chrome: #f7f9fb;
      --surface: #ffffff;
      --surface-muted: #f1f6f5;
      --text: #111827;
      --muted: #5f6b7a;
      --border: #d9e1e7;
      --accent: #0f766e;
      --accent-strong: #0b5f59;
      --accent-soft: #e5f5f2;
      --amber: #d97706;
      --code: #f3f5f7;
      --shadow: 0 12px 30px rgba(17, 24, 39, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    * {
      box-sizing: border-box;
    }

    html {
      background: var(--chrome);
      scroll-padding-top: 88px;
    }

    body {
      margin: 0;
      color: var(--text);
      background: var(--background);
    }

    a {
      color: var(--accent);
      text-decoration-thickness: 0.08em;
      text-underline-offset: 0.18em;
    }

    a:hover {
      color: var(--accent-strong);
    }

    .site-header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 70px;
      padding: 0 28px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(16px);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      color: var(--text);
      text-decoration: none;
      font-weight: 760;
    }

    .brand-mark {
      display: grid;
      width: 32px;
      height: 32px;
      place-items: center;
      border-radius: 6px;
      background: #073b3a;
      color: white;
      font-size: 18px;
      font-weight: 820;
      letter-spacing: 0;
    }

    .top-nav {
      display: flex;
      align-items: center;
      gap: 22px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 640;
    }

    .top-nav a {
      color: inherit;
      text-decoration: none;
    }

    .top-nav a[aria-current="page"] {
      color: var(--accent);
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      background: var(--surface);
      font-size: 13px;
      font-weight: 640;
    }

    .status::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--amber);
    }

    .docs-shell {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(180px, 240px);
      min-height: calc(100vh - 70px);
    }

    .sidebar,
    .toc {
      align-self: start;
      height: calc(100vh - 70px);
      overflow: auto;
      background: var(--chrome);
    }

    .sidebar {
      position: sticky;
      top: 70px;
      padding: 22px 20px 28px;
      border-right: 1px solid var(--border);
    }

    .sidebar-section {
      padding: 0 0 20px;
      margin: 0 0 20px;
      border-bottom: 1px solid var(--border);
    }

    .sidebar-section:last-child {
      border-bottom: 0;
    }

    .sidebar-section h2,
    .toc h2 {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .sidebar-link,
    .toc-link {
      display: block;
      border-radius: 6px;
      color: #334155;
      text-decoration: none;
    }

    .sidebar-link {
      padding: 8px 10px;
      font-size: 14px;
      font-weight: 560;
    }

    .sidebar-link.active {
      background: var(--accent-soft);
      color: var(--accent-strong);
      box-shadow: inset 3px 0 0 var(--accent);
    }

    .content {
      min-width: 0;
      padding: 42px clamp(28px, 5vw, 72px) 80px;
      background: var(--background);
    }

    .article {
      max-width: 820px;
      overflow-wrap: break-word;
    }

    .article h1 {
      margin: 0 0 18px;
      color: var(--text);
      font-size: clamp(36px, 5vw, 52px);
      line-height: 1.04;
      font-weight: 790;
      letter-spacing: 0;
    }

    .article h2 {
      margin: 42px 0 14px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
      font-size: 22px;
      line-height: 1.22;
      letter-spacing: 0;
    }

    .article h3 {
      margin: 28px 0 10px;
      font-size: 18px;
      letter-spacing: 0;
    }

    .article p,
    .article li {
      color: #263241;
      font-size: 16px;
    }

    .article p {
      margin: 0 0 16px;
    }

    .article ul,
    .article ol {
      margin: 0 0 18px;
      padding-left: 24px;
    }

    .article li + li {
      margin-top: 7px;
    }

    .article code {
      border-radius: 5px;
      padding: 0.12em 0.38em;
      background: var(--code);
      color: #122031;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.88em;
    }

    .article pre {
      overflow-x: auto;
      margin: 18px 0 24px;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #0f172a;
      box-shadow: var(--shadow);
    }

    .article pre code {
      display: block;
      padding: 0;
      color: #e2e8f0;
      background: transparent;
      font-size: 13px;
      line-height: 1.65;
    }

    .article blockquote {
      margin: 20px 0;
      padding: 14px 18px;
      border-left: 4px solid var(--accent);
      background: var(--surface-muted);
      color: #263241;
    }

    .article img {
      max-width: 100%;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .table-scroll {
      overflow-x: auto;
      margin: 18px 0 24px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th,
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }

    th {
      background: var(--chrome);
      color: var(--text);
      font-weight: 700;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .pipeline {
      display: grid;
      grid-template-columns: 1fr auto 1fr auto 1fr;
      gap: 14px;
      align-items: stretch;
      margin: 28px 0 34px;
      padding: 20px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }

    .pipeline-stage {
      display: grid;
      gap: 8px;
      min-width: 0;
      padding: 16px;
      border: 1px solid #b7d9d4;
      border-radius: 7px;
      background: #fbfefd;
    }

    .stage-label {
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .pipeline-stage strong {
      font-size: 16px;
    }

    .pipeline-arrow {
      align-self: center;
      color: var(--muted);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 22px;
    }

    .toc {
      position: sticky;
      top: 70px;
      padding: 30px 24px;
      border-left: 1px solid var(--border);
    }

    .toc-link {
      padding: 7px 0;
      font-size: 13px;
      line-height: 1.35;
    }

    .toc-link.nested {
      padding-left: 12px;
      color: var(--muted);
    }

    .toc-empty {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }

    .site-footer {
      max-width: 820px;
      margin-top: 56px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 13px;
    }

    @media (max-width: 1120px) {
      .docs-shell {
        grid-template-columns: minmax(210px, 260px) minmax(0, 1fr);
      }

      .toc {
        display: none;
      }
    }

    @media (max-width: 760px) {
      .site-header {
        position: static;
        min-height: auto;
        flex-direction: column;
        align-items: stretch;
        gap: 14px;
        padding: 16px;
      }

      .top-nav {
        flex-wrap: wrap;
        gap: 14px;
      }

      .docs-shell {
        display: flex;
        flex-direction: column;
      }

      .sidebar {
        position: static;
        order: 2;
        height: auto;
        border-right: 0;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
      }

      .sidebar-section {
        margin-bottom: 14px;
        padding-bottom: 14px;
      }

      .content {
        order: 1;
        width: 100%;
        min-width: 0;
        overflow: hidden;
        padding: 30px 18px 56px;
      }

      .article {
        max-width: 100%;
      }

      .article h1 {
        max-width: 320px;
        font-size: 28px;
        line-height: 1.08;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .article p,
      .article li {
        font-size: 15px;
      }

      .pipeline {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 100%;
        padding: 14px;
        overflow: hidden;
      }

      .pipeline-stage {
        width: 100%;
        min-width: 0;
        padding: 14px;
      }

      .pipeline-stage code {
        display: block;
        white-space: normal;
        overflow-wrap: anywhere;
      }

      .pipeline-arrow {
        justify-self: center;
        font-size: 0;
        transform: none;
      }

      .pipeline-arrow::before {
        content: "v";
        font-size: 20px;
      }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <a class="brand" href="${escapeAttribute(rewriteDocsRootUrl("index.md", currentRelativePath))}">
      <span class="brand-mark" aria-hidden="true">H</span>
      <span>HTMLslide</span>
    </a>
    <nav class="top-nav" aria-label="Primary">
      <a href="${escapeAttribute(rewriteDocsRootUrl("index.md", currentRelativePath))}" aria-current="page">Docs</a>
      <a href="${escapeAttribute(repositoryUrl)}" target="_blank" rel="noreferrer">GitHub</a>
      <a href="${escapeAttribute(`${repositoryUrl}/releases`)}" target="_blank" rel="noreferrer">Releases</a>
      <span class="status">Public alpha</span>
    </nav>
  </header>
  <div class="docs-shell">
    <aside class="sidebar" aria-label="Documentation navigation">
      ${sidebar}
    </aside>
    <main class="content">
      <article class="article">
        ${articleBody}
      </article>
      <footer class="site-footer">
        Built from repository Markdown with <code>pnpm docs:build</code>. Edit source files under <code>docs/</code>.
      </footer>
    </main>
    <aside class="toc" aria-label="On this page">
      <h2>On This Page</h2>
      ${toc}
    </aside>
  </div>
</body>
</html>
`;
}

async function writePage(relativePath) {
  const sourcePath = path.join(docsRoot, relativePath);
  const markdown = await readFile(sourcePath, "utf8");
  const title = pageTitle(markdown, relativePath);
  const rendered = renderMarkdown(markdown, relativePath);
  const html = layout({
    body: rendered.body,
    currentRelativePath: relativePath,
    description: pageDescription(title, relativePath),
    headings: rendered.headings,
    title
  });
  const outputRelativePath = markdownOutputPath(relativePath);
  const outputPath = path.join(outputRoot, outputRelativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  return outputRelativePath;
}

async function copyAsset(relativePath) {
  const sourcePath = path.join(docsRoot, relativePath);
  const outputPath = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await copyFile(sourcePath, outputPath);
  return relativePath;
}

async function validateGeneratedLinks(htmlFiles) {
  const failures = [];

  for (const relativePath of htmlFiles) {
    const absolutePath = path.join(outputRoot, relativePath);
    const html = await readFile(absolutePath, "utf8");
    const attributes = html.matchAll(/\s(?:href|src)="([^"]+)"/gu);

    for (const match of attributes) {
      const value = match[1];
      if (!value || value.startsWith("#") || isExternalUrl(value) || value.startsWith("mailto:") || value.startsWith("data:")) {
        continue;
      }

      const targetPath = value.split(/[?#]/u)[0] ?? "";
      if (!targetPath) {
        continue;
      }

      const absoluteTarget = path.resolve(path.dirname(absolutePath), targetPath);
      if (!isInside(absoluteTarget, outputRoot)) {
        failures.push(`${relativePath} links outside the docs site: ${value}`);
        continue;
      }

      try {
        await readFile(absoluteTarget);
      } catch {
        failures.push(`${relativePath} has missing generated asset/link: ${value}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

async function build() {
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");
  await writeFile(
    path.join(outputRoot, "favicon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#073b3a"/><path fill="#fff" d="M18 18h8v10h12V18h8v28h-8V35H26v11h-8z"/></svg>\n',
    "utf8"
  );

  const allFiles = await collectFiles(docsRoot);
  const relativeFiles = allFiles
    .map((file) => toPosixPath(path.relative(docsRoot, file)))
    .sort((a, b) => a.localeCompare(b));

  const markdownFiles = relativeFiles.filter((file) => file.endsWith(".md"));
  const assetFiles = relativeFiles.filter((file) => !file.endsWith(".md"));

  const htmlFiles = [];
  for (const relativePath of markdownFiles) {
    htmlFiles.push(await writePage(relativePath));
  }

  for (const relativePath of assetFiles) {
    await copyAsset(relativePath);
  }

  await validateGeneratedLinks(htmlFiles);

  const indexPath = path.join(outputRoot, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  if (!indexHtml.includes("HTMLslide Documentation")) {
    throw new Error("Generated docs site is missing the HTMLslide Documentation homepage.");
  }

  process.stdout.write(`Built HTMLslide docs site: ${htmlFiles.length} pages, ${assetFiles.length} assets -> ${path.relative(root, outputRoot)}\n`);
}

await build();
