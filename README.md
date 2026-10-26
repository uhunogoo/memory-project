# Book Memory

Проєкт натхненний [QMD](https://github.com/tobi/qmd) та ідеєю локального інструмента для роботи з власними книгами й документами.

## Поточний функціонал

Локальний CLI та TypeScript API для парсингу документів і поділу тексту на чанки через `officeparser@8.2.0`. Підтримуються формати бібліотеки, зокрема MD, PDF, DOCX, PPTX, XLSX, ODT, ODP, ODS, RTF, CSV та HTML.

Використовується стратегія `fixed-size`: бібліотека ділить витягнутий текст на фрагменти заданого розміру з перекриттям. Типовий розмір — `2000` одиниць UTF-16 (`text.length`), перекриття — `min(200, floor(chunkSize / 5))`. Це розмір тексту, а не кількість токенів моделі. Фактичні межі чанків визначає officeparser.

Результат містить текст чанків, метадані та координати у витягнутому тексті. OCR вимкнено, тому скановані документи без текстового шару можуть не дати корисного тексту.

## Запуск

Потрібні Node.js 24+ та pnpm.

```bash
vp install
vp build
vp memory chunk document.md
vp memory chunk book.pdf --chunk-size 3000 > chunks.json
vp memory chunk report.docx --chunk-size 1000
```

Єдина команда — `chunk FILE`. Вона обробляє один файл і друкує JSON у stdout. Помилки виводяться у stderr з кодом завершення `1`.

## Налаштування

| Параметр CLI          | Значення                                                              |
| --------------------- | --------------------------------------------------------------------- |
| `--chunk-size NUMBER` | Додатне безпечне ціле число; типово `2000`. Розмір у одиницях UTF-16. |

Перекриття обчислюється автоматично. Типові значення розміру, перекриття та стратегія задані в [`src/config.ts`](src/config.ts).

## Результат

```ts
type ChunkResult = {
  source: string;
  chunks: OfficeChunk[];
  messages: OfficeIssue[];
};
```

- `source` — абсолютний шлях до документа.
- `chunks` — чанки officeparser без додаткового перетворення: `text`, `metadata` та необов'язкові `startIndex` / `endIndex`.
- `messages` — діагностика парсингу й генерації від officeparser.

Метадані залежать від формату й можуть містити `sourceType`, `pageNumber`, `slideNumber`, `sheetName`, `closestHeading`. Індекси стосуються перетвореного тексту бібліотеки, а не позицій в оригінальному файлі.

## TypeScript API

```ts
import { chunkFile } from "book-memory";

const result = await chunkFile("report.pdf");

const smallerChunks = await chunkFile("document.md", {
  chunkSize: 1000,
});
```

`chunkFile(filePath, options?)` приймає шлях до файлу та необов'язковий `chunkSize` як число або числовий рядок. Типовий розмір і формула перекриття ті самі, що й у CLI. Пакет також експортує тип `OfficeChunk` з officeparser.

## Розробка

```bash
vp dev
vp check
vp build
```

`dev` збирає CLI та бібліотеку в режимі спостереження, `check` перевіряє форматування, lint і типи, `build` створює ESM-збірку та декларації типів у `dist/`.
