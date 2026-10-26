# Book Memory

Локальний інструмент для поділу книг і документів на чанки через `officeparser`. Натхненний [QMD](https://github.com/tobi/qmd).

## Запуск

Потрібні Node.js 24+, pnpm і Vite+ (`vp`). Команди виконуй із кореня проєкту.

Поклади Markdown-файли в `books/`: кожна підпапка — окрема книга. Вкладені папки також скануються.

```text
books/
  my-book/
    chapter-01.md
    chapter-02.md
```

```bash
vp install
vp exec drizzle-kit generate
vp run build
vp run memory index
vp run memory index --chunk-size 1000
```

CLI обробляє лише `.md` і друкує окремий JSON `{ source, chunks, messages }` для кожного файла: абсолютний шлях, чанки з метаданими та діагностику парсингу.

`--chunk-size` — додатне ціле число; типово `2000` одиниць UTF-16, не токенів. Стратегія — `fixed-size`, перекриття — `min(200, floor(chunkSize / 5))`. Каталог книг і типові параметри задані в [`src/config.ts`](src/config.ts).

## База даних

Під час `index` автоматично створюється SQLite-файл `.data/memory.sqlite` і застосовуються міграції з `drizzle/`. Є таблиці `books`, `chunks`, `embeddings`; запис даних, генерація embeddings і пошук поки не реалізовані.

Після зміни [`src/schemas/schema.ts`](src/schemas/schema.ts) повтори `vp exec drizzle-kit generate`. Нові міграції застосуються під час наступного `index`. Папка `drizzle/` має бути доступна поруч із `dist/`.

## TypeScript API

```ts
import { chunkFile } from "book-memory";

const result = await chunkFile("report.pdf", { chunkSize: 1000 });
```

API працює з одним файлом у форматах `officeparser`, зокрема MD, PDF і DOCX, та повертає `{ source, chunks, messages }`. Пакет також експортує тип `OfficeChunk`.

## Розробка

```bash
vp run dev   # збірка в режимі спостереження
vp check     # форматування, lint і типи
```
