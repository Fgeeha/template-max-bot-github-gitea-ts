#!/usr/bin/env tsx
/**
 * Сборка HTML-документации из docs/*.md → docs/html/.
 *
 * Источник правды — Markdown; HTML генерируется и не правится руками:
 *     make docs        (= pnpm docs)
 *
 * Результат открывается без сервера: docs/html/index.html. Внешних ресурсов
 * нет. Стили и скрипт страницы — scripts/docs-assets/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "scripts", "docs-assets");
const OUT = path.join(ROOT, "docs", "html");
const BRAND = "max-bot-template";

type Item = [src: string, label: string, about: string];

// Порядок и группы навигации. В новом проекте замените разделы своими документами.
// docs/TEMPLATE.md появляется только после `make init` в проекте, созданном из
// шаблона, — в самом шаблоне это README.md; отсутствующий файл в навигацию не попадает.
const OPTIONAL = new Set(["docs/TEMPLATE.md"]);
const SECTIONS: [group: string, items: Item[]][] = (
  [
    [
      "Работа с ботом",
      [
        ["docs/admin-guide.md", "Руководство администратора", "Админка, разделы, статистика"],
        ["README.md", "Запуск и настройка", "Docker, переменные, команды"],
      ],
    ],
    [
      "Разработка",
      [["docs/TEMPLATE.md", "Устройство шаблона", "Архитектура, CI/CD, закрытый контур"]],
    ],
  ] as [string, Item[]][]
).map(([group, items]) => [
  group,
  items.filter(([src]) => !OPTIONAL.has(src) || existsSync(path.join(ROOT, src))),
]);

// Значок раздела в навигации и на главной.
const ICONS: Record<string, string> = {
  "docs/admin-guide.md": "🛠",
  "README.md": "🚀",
  "docs/TEMPLATE.md": "📐",
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;/g, "'");

/** Якоря с кириллицей: #вход-и-роли, а не #_1 (как slugify_unicode у Python-Markdown). */
function slugify(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "-");
}

const outName = (src: string): string =>
  src === "README.md" ? "index.html" : `${path.basename(src, ".md")}.html`;

/** Путь исходника (как его пишут в тексте) → имя HTML-страницы. */
function pageMap(): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [, items] of SECTIONS) {
    for (const [src] of items) {
      mapping.set(src, outName(src));
      mapping.set(path.basename(src), outName(src));
    }
  }
  return mapping;
}

/** Упоминания `docs/…md` в тексте и ссылки на .md превращаются в ссылки на страницы. */
function linkDocs(body: string, mapping: Map<string, string>): string {
  let out = body.replace(/<code>((?:docs\/)?[\w./-]+\.md)<\/code>/g, (whole, ref: string) => {
    const target = mapping.get(ref);
    return target ? `<a href="${target}"><code>${ref}</code></a>` : whole;
  });
  out = out.replace(
    /href="((?:\.\.\/|docs\/)*)([\w./-]+\.md)"/g,
    (_whole, _prefix, ref: string) => {
      const target = mapping.get(ref) ?? mapping.get(path.basename(ref)) ?? ref;
      return `href="${target}"`;
    },
  );
  // Голые пути «docs/x.md» в обычном тексте (вне тегов и ссылок).
  return out
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>|<pre>[\s\S]*?<\/pre>|<[^>]+>)/)
    .map((part) =>
      part.startsWith("<")
        ? part
        : part.replace(/(?:docs\/)?[\w-]+(?:\/[\w-]+)*\.md/g, (ref) => {
            const target = mapping.get(ref);
            return target ? `<a href="${target}">${ref}</a>` : ref;
          }),
    )
    .join("");
}

interface Heading {
  depth: number;
  id: string;
  text: string;
}

/** Оглавление по заголовкам h2–h3: вложенные <ul>, как у Python-Markdown toc. */
function buildToc(headings: Heading[]): string {
  let html = "";
  let level = 1;
  for (const h of headings.filter((h) => h.depth >= 2 && h.depth <= 3)) {
    if (h.depth > level) html += "<ul>".repeat(h.depth - level);
    else html += "</li>";
    if (h.depth < level) html += "</ul></li>".repeat(level - h.depth);
    html += `<li><a href="#${h.id}">${escapeHtml(h.text)}</a>`;
    level = h.depth;
  }
  if (level > 1) html += `</li>${"</ul></li>".repeat(level - 2)}</ul>`;
  return html;
}

/** Заголовок, html тела и html оглавления. */
function render(src: string): { title: string; body: string; toc: string } {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = stripTags(inner).trim();
        const base = slugify(text) || "section";
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        const id = seen ? `${base}_${seen}` : base;
        headings.push({ depth, id, text });
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" title="Permanent link">#</a></h${depth}>\n`;
      },
    },
  });
  const body = (marked.parse(readFileSync(src, "utf8")) as string)
    .replaceAll("<table>", '<div class="table"><table>')
    .replaceAll("</table>", "</table></div>");
  const h1 = headings.find((h) => h.depth === 1);
  return { title: h1?.text ?? path.basename(src, ".md"), body, toc: buildToc(headings) };
}

function nav(active: string): string {
  return SECTIONS.map(([group, items]) => {
    const links = items.map(([src, label, about]) => {
      const name = outName(src);
      const cls = name === active ? ' class="active"' : "";
      return (
        `<li><a href="${name}"${cls} title="${escapeHtml(about)}">` +
        `<span class="ic">${ICONS[src] ?? "📄"}</span>${escapeHtml(label)}</a></li>`
      );
    });
    return `<h4>${escapeHtml(group)}</h4><ul>${links.join("")}</ul>`;
  }).join("");
}

/** Файл, заголовок и группа в порядке навигации — для «назад/далее». */
const flatPages = (): [string, string, string][] =>
  SECTIONS.flatMap(([group, items]) =>
    items.map(([src, label]) => [src, label, group] as [string, string, string]),
  );

function pager(name: string): string {
  const pages = flatPages();
  const idx = pages.findIndex(([src]) => outName(src) === name);
  const out: string[] = [];
  const prev = pages[idx - 1];
  const next = pages[idx + 1];
  if (prev)
    out.push(`<a href="${outName(prev[0])}"><small>← Назад</small>${escapeHtml(prev[1])}</a>`);
  if (next) {
    out.push(
      `<a class="next" href="${outName(next[0])}"><small>Далее →</small>${escapeHtml(next[1])}</a>`,
    );
  }
  return `<nav class="pager" aria-label="Соседние страницы">${out.join("")}</nav>`;
}

/** Вставляет блок перед заголовком страницы (h1). */
function beforeTitle(article: string, block: string): string {
  const i = article.indexOf("<h1");
  return block && i >= 0 ? article.slice(0, i) + block + article.slice(i) : article;
}

/** Вставляет блок сразу после заголовка страницы (h1). */
function afterTitle(article: string, block: string): string {
  if (!block) return article;
  return article.includes("</h1>") ? article.replace("</h1>", `</h1>${block}`) : block + article;
}

function page(
  name: string,
  title: string,
  article: string,
  toc: string,
  stamp: string,
  js: string,
): string {
  const hasToc = (toc.match(/<li>/g) ?? []).length > 2 && name !== "index.html";
  const group = flatPages().find(([src]) => outName(src) === name)?.[2] ?? "";
  const eyebrow =
    group && name !== "index.html" ? `<span class="eyebrow">${escapeHtml(group)}</span>` : "";
  const inline = hasToc
    ? `<details class="toc-inline"><summary>Содержание</summary>${toc}</details>`
    : "";
  const sideToc = hasToc
    ? `<aside class="otp" aria-label="На этой странице"><b>На этой странице</b>${toc}</aside>`
    : "";
  const body = afterTitle(beforeTitle(article, eyebrow), inline);
  const docTitle = name === "index.html" ? BRAND : `${title} — ${BRAND}`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(docTitle)}</title>
<link rel="stylesheet" href="style.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%239a3f12'/%3E%3Cpath d='M8 3.2a3 3 0 0 0-3 3c0 2.3 3 6.2 3 6.2s3-3.9 3-6.2a3 3 0 0 0-3-3zm0 4.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z' fill='%23fff'/%3E%3C/svg%3E"></head>
<body><div class="layout">
<button class="btn menu-btn" type="button" aria-label="Открыть меню разделов">☰ ${escapeHtml(BRAND)}</button>
<nav class="side" aria-label="Разделы документации">
<a class="brand" href="index.html"><span class="logo">💬</span><span><b>${escapeHtml(BRAND)}</b><small>Документация · MAX</small></span></a>
<label class="search"><input id="q" type="search" placeholder="Найти на странице  ( / )" aria-label="Найти на странице"><span class="hits" id="hits" aria-live="polite"></span></label>
${nav(name)}
<div class="tools"><button class="btn" id="theme" type="button">Тема</button></div>
</nav>
<main class="content"><div class="page${hasToc ? "" : " wide"}"><article>${body}${pager(name)}</article>${sideToc}</div>
<footer>Собрано из Markdown ${stamp} · <code>make docs</code> · источник — <code>docs/*.md</code></footer></main>
</div><button class="btn top" type="button" aria-label="Наверх">↑ Наверх</button>
<script>${js}</script></body></html>
`;
}

function indexCards(): string {
  const groups = SECTIONS.map(([group, items]) => {
    const cards = items.map(
      ([src, label, about]) =>
        `<a class="card" href="${outName(src)}"><span class="ic">${ICONS[src] ?? "📄"}</span>` +
        `<span><b>${escapeHtml(label)}</b><span>${escapeHtml(about)}</span></span></a>`,
    );
    return `<h3>${escapeHtml(group)}</h3><div class="cards">${cards.join("")}</div>`;
  });
  return `<h2 id="docs">Разделы документации</h2>${groups.join("")}`;
}

/** Заголовок README и вводный абзац → шапка главной с быстрыми ссылками. */
function indexHero(body: string): string {
  const head = /<h1[^>]*>[\s\S]*?<\/h1>\s*(<p>[\s\S]*?<\/p>)?/.exec(body);
  if (!head) return body;
  const hero =
    `<section class="hero"><span class="eyebrow">Документация · ${BRAND}</span>` +
    `<h1>${escapeHtml(BRAND)}</h1>${head[1] ?? ""}` +
    '<div class="actions"><a class="primary" href="admin-guide.html">🛠 Руководство администратора</a>' +
    '<a href="#быстрый-старт">🚀 Быстрый старт</a></div></section>';
  return body.slice(0, head.index) + hero + indexCards() + body.slice(head.index + head[0].length);
}

function stampNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function build(): number {
  mkdirSync(OUT, { recursive: true });
  const mapping = pageMap();
  const stamp = stampNow();
  const js = readFileSync(path.join(ASSETS, "docs.js"), "utf8").trim();
  const missing: string[] = [];
  for (const [, items] of SECTIONS) {
    for (const [src] of items) {
      const file = path.join(ROOT, src);
      if (!existsSync(file)) {
        missing.push(src);
        continue;
      }
      const { title, body, toc } = render(file);
      const name = outName(src);
      let linked = linkDocs(body, mapping);
      if (name === "index.html") linked = indexHero(linked);
      writeFileSync(path.join(OUT, name), page(name, title, linked, toc, stamp, js), "utf8");
    }
  }
  writeFileSync(path.join(OUT, "style.css"), readFileSync(path.join(ASSETS, "style.css"), "utf8"));
  if (missing.length > 0) {
    console.error(`Нет исходников: ${missing.join(", ")}`);
    return 1;
  }
  console.info(`Документация собрана: ${path.relative(ROOT, OUT)}/index.html`);
  return 0;
}

process.exitCode = build();
