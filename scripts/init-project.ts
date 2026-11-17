#!/usr/bin/env tsx
/**
 * Инициализация нового проекта из шаблона.
 *
 * Спрашивает имя бота и описание, подставляет их во все файлы, где зашито имя
 * шаблона, и предлагает начать историю git с нуля.
 *
 * Запуск: make init (или pnpm run init-project)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Плейсхолдеры, которые несёт шаблон.
const TEMPLATE_SLUG = "max-bot-template";
const TEMPLATE_DESCRIPTION =
  "Шаблон чат-бота для мессенджера MAX (GitHub + Gitea CI/CD, TypeScript)";

// Файлы, в которых заменяются плейсхолдеры. Список явный: слепой обход дерева
// зацепил бы node_modules, .git и логи.
const TARGET_FILES = [
  "package.json",
  "docker/docker-compose.local.yml",
  "docker/docker-compose.prod.yml",
  ".gitea/workflows/pipeline.yml",
  "README.md",
  "scripts/build-docs.ts",
];

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/;

interface ProjectInfo {
  slug: string;
  description: string;
}

interface Args {
  name?: string;
  description?: string;
  keepGit: boolean;
  keepScript: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { keepGit: false, keepScript: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--name") args.name = argv[++i];
    else if (arg === "--description") args.description = argv[++i];
    else if (arg === "--keep-git") args.keepGit = true;
    else if (arg === "--keep-script") args.keepScript = true;
  }
  return args;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

function validateSlug(slug: string): string | undefined {
  if (!SLUG_PATTERN.test(slug)) {
    return (
      "Имя должно быть в kebab-case: строчные латинские буквы, цифры и " +
      "дефисы, 3–50 символов, начинаться с буквы (например: support-max-bot)"
    );
  }
  if (slug === TEMPLATE_SLUG) return "Оставлено имя шаблона — задайте своё";
  return undefined;
}

async function collectInfo(args: Args): Promise<ProjectInfo> {
  let slug = args.name ?? "";
  for (;;) {
    if (!slug) slug = await ask("Имя проекта (kebab-case)");
    const error = validateSlug(slug);
    if (!error) break;
    console.error(`  ${error}`);
    slug = "";
  }

  const description =
    args.description ?? (await ask("Описание бота", `Чат-бот ${slug} для мессенджера MAX`));
  return { slug, description };
}

function replaceInFiles(info: ProjectInfo): string[] {
  const changed: string[] = [];
  for (const relative of TARGET_FILES) {
    const filePath = path.join(ROOT, relative);
    if (!existsSync(filePath)) continue;
    const original = readFileSync(filePath, "utf8");
    const updated = original
      .replaceAll(TEMPLATE_SLUG, info.slug)
      .replaceAll(TEMPLATE_DESCRIPTION, info.description);
    if (updated !== original) {
      writeFileSync(filePath, updated, "utf8");
      changed.push(relative);
    }
  }
  return changed;
}

/**
 * Заменяет README шаблона заготовкой под новый проект.
 *
 * Исходный README сохраняется как docs/TEMPLATE.md — в нём описано устройство
 * шаблона, и терять его при инициализации не хочется.
 */
function writeReadme(info: ProjectInfo): void {
  const readme = path.join(ROOT, "README.md");
  const docs = path.join(ROOT, "docs");
  mkdirSync(docs, { recursive: true });
  if (existsSync(readme)) {
    renameSync(readme, path.join(docs, "TEMPLATE.md"));
  }

  writeFileSync(
    readme,
    `# ${info.slug}

${info.description}

## Быстрый старт

\`\`\`bash
cp .env.example .env      # задать MAX_BOT_TOKEN и ADMIN_IDS
make install
make run
\`\`\`

Устройство проекта, команды и деплой описаны в [docs/TEMPLATE.md](docs/TEMPLATE.md).
`,
    "utf8",
  );
}

/** Начинает историю заново одним коммитом. user.name/user.email не трогаем — берутся из окружения разработчика. */
function resetGitHistory(info: ProjectInfo): void {
  const gitDir = path.join(ROOT, ".git");
  if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true });
  execFileSync("git", ["init", "-b", "Master"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("git", ["add", "-A"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("git", ["commit", "-m", `chore: инициализация проекта ${info.slug}`], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

/** Удаляет то, что нужно только самому шаблону. */
function cleanupTemplateFiles(): void {
  const scriptPath = path.join(ROOT, "scripts/init-project.ts");
  if (existsSync(scriptPath)) rmSync(scriptPath);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const info = await collectInfo(args);

  console.log();
  console.log(`  Имя:      ${info.slug}`);
  console.log(`  Описание: ${info.description}`);
  console.log(`  История:  ${args.keepGit ? "сохраняется" : "начинается заново"}`);
  console.log();
  const proceed = (await ask("Продолжить? (y/n)", "y")).toLowerCase();
  if (!["y", "yes", "д", "да"].includes(proceed)) {
    console.log("Отменено.");
    return 1;
  }

  const changed = replaceInFiles(info);
  writeReadme(info);
  for (const file of changed) console.log(`  обновлён ${file}`);

  if (!args.keepScript) cleanupTemplateFiles();
  if (!args.keepGit) resetGitHistory(info);

  console.log();
  console.log("Готово. Дальше:");
  console.log("  1. cp .env.example .env и заполнить MAX_BOT_TOKEN, ADMIN_IDS");
  console.log("  2. make install && make run");
  console.log("  3. заменить разделы меню в src/keyboards/menus.ts");
  return 0;
}

main()
  .then((code) => {
    rl.close();
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    rl.close();
    console.error(error);
    process.exitCode = 1;
  });
