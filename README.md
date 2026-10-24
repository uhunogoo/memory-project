# Document chunking

Локальний CLI та TypeScript API для чанкування документів через `officeparser@8.2.0`. Парсинг і поділ повністю виконує бібліотека; власного алгоритму чанкування, БД, embeddings чи пошуку немає.

## Запуск

Потрібні Node.js 24+ та pnpm.

```bash
pnpm install
pnpm build
pnpm memory chunk document.md
pnpm memory chunk book.pdf --split-by page --chunk-size 2000 > chunks.json
pnpm memory chunk report.docx --split-by heading
pnpm memory chunk document.md --strategy fixed-size --chunk-size 1000 --overlap 200
pnpm memory --help
```

Єдина команда — `chunk FILE`. Підтримуються формати officeparser, зокрема MD, PDF, DOCX, PPTX, XLSX, ODT, ODP, ODS, RTF, CSV та HTML. OCR вимкнено: скановані документи без текстового шару можуть не дати корисного тексту.

## Налаштування

| Параметр        | Значення                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `--strategy`    | `document-structure` (типово) або `fixed-size`                                                       |
| `--chunk-size`  | Додатне ціле число, типово `1000`; одиниця — UTF-16 code unit (`text.length`), не токен              |
| `--split-by`    | Для структурної стратегії: `paragraph` (типово), `heading`, `page`, `slide`, `sheet`                 |
| `--table-split` | Для структурної стратегії: `row` (типово, повторює заголовок таблиці) або `flatten`                  |
| `--overlap`     | Лише для fixed-size: ціле число від 0 до розміру чанка невключно; типово `min(200, floor(size / 5))` |

Розмір і межі фрагментів визначаються реалізацією officeparser. Параметри структурного поділу слід обирати під формат: `page` для PDF, `slide` для презентацій, `sheet` для таблиць. Несумісні зі стратегією CLI-параметри відхиляються.

## Результат і координати

Stdout містить JSON: `{ source, chunks, messages }`. `source` — абсолютний шлях; `chunks` — незмінені `OfficeChunk` бібліотеки; `messages` — діагностика конвертації. Фатальні помилки виводяться у stderr з кодом завершення 1.

Чанк містить `text`, `metadata` та, якщо бібліотека їх повернула, `startIndex` / `endIndex`. Метадані можуть включати `sourceType`, `pageNumber`, `slideNumber`, `sheetName`, `closestHeading`.

Передаємо `addStartIndex: true`, але наявність індексів залежить від стратегії: у перевіреному структурному поділі MD officeparser їх не повертає; у fixed-size вони присутні. Це координати перетвореного тексту бібліотеки, не байти PDF і не точні offsets оригінального Markdown. Точна відповідність зрізу тексту та підсвічування PDF не гарантуються.

Старі `parseMarkdown`, `sections`, `headingPath`, GitHub anchors, оригінальний `markdown`, номери рядків і `estimatedTokens` видалені. Параметри `--target-tokens` та `--overlap-tokens` більше не підтримуються.

## API

```ts
import { chunkFile } from "book-memory";

const result = await chunkFile("report.pdf", {
  strategy: "document-structure",
  splitBy: "page",
  maxChunkSize: 2000,
});

const fixed = await chunkFile("document.md", {
  strategy: "fixed-size",
  chunkSize: 1000,
  chunkOverlap: 100,
});
```

API приймає типізовані опції структурної та fixed-size стратегій officeparser, включно з `separators`, `lengthFunction`, `abbreviations` там, де вони підтримуються. Semantic-стратегія не входить у цей API, бо потребує embeddings.

## Розробка

```bash
pnpm check
pnpm build
```

Необов’язковий postinstall Tesseract, який показує повідомлення OpenCollective, вимкнено через `allowBuilds` у `pnpm-workspace.yaml`.
