# Markdown chunking

CLI та TypeScript API для поділу Markdown-файлів на чанки. Без бази даних, індексації, embeddings чи пошуку.

## Запуск

Потрібні Node.js 24+ та pnpm.

```bash
pnpm install
pnpm build
pnpm memory chunk books/example.md
pnpm memory chunk books/example.md --target-tokens 800 --overlap-tokens 100 > chunks.json
pnpm memory --help
```

Єдина команда — `chunk FILE.md`. Результат у stdout — JSON із `title`, `sections` та `chunks`. Помилки виводяться у stderr з ненульовим кодом завершення. Підтримується лише Markdown; PDF поки не підтримується.

## Налаштування

- `--target-tokens`: додатне ціле число, типово `800`.
- `--overlap-tokens`: невід’ємне ціле число, менше за розмір чанка; типово `min(100, floor(targetTokens / 8))`.

Розмір оцінюється як кількість UTF-8 байтів / 3, це не точний підрахунок токенів моделі. Перекриття не переходить між розділами й додатково обмежене третиною байтового бюджету чанка. Межі Markdown-блоків можуть зменшити фактичне перекриття.

## Результат

Парсер використовує Markdown AST: CommonMark, GFM та YAML frontmatter. Назва документа береться з `title` у frontmatter, першого H1 або назви файлу.

Кожен чанк містить оригінальний `markdown`, очищений `text`, шлях заголовків, ідентифікатор розділу та координати. Розділи містять GitHub-сумісні anchors з обробкою дублікатів.

- `startOffset` / `endOffset`: UTF-16 позиції, кінець виключний; `markdown.slice(startOffset, endOffset)` відтворює чанк.
- `startLine` / `endLine`: номери рядків від 1, обидва включні.
- `estimatedTokens`: оцінка розміру оригінального Markdown чанка.

Великі блоки коду, списки й таблиці можуть ділитися по рядках або словах. Такий чанк не обов’язково є самодостатнім Markdown-блоком.

## API

```ts
import { parseMarkdown } from "book-memory";

const result = parseMarkdown("document-id", "# Заголовок\n\nТекст", "Документ", {
  targetTokens: 800,
  overlapTokens: 100,
});
```

## Розробка

```bash
pnpm check
pnpm build
```
