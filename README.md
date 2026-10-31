# Book Memory

Локальний інструмент для індексації Markdown-книг і гібридного пошуку по них. Ділить документи на чанки через `officeparser`, зберігає їх у SQLite, створює embeddings через Ollama та поєднує повнотекстовий і векторний пошук. Натхненний [QMD](https://github.com/tobi/qmd).

## Налаштування

Потрібні Node.js 24+, pnpm, Vite+ (`vp`) і запущений Ollama з моделлю embeddings, яка повертає вектори розмірності `768`. Команди виконуй із кореня проєкту.

```bash
vp install
vp run build
```

Створи `.env` у корені та заміни `your-embedding-model` на назву своєї моделі:

```dotenv
EMBEDDING_MODEL=your-embedding-model
```

Завантаж цю ж модель командою `ollama pull your-embedding-model`. Якщо Ollama ще не запущений, запусти `ollama serve` в окремому терміналі. Клієнт використовує стандартне локальне підключення Ollama (`http://127.0.0.1:11434`).

`.env` завантажується автоматично. Модель і розмірність налаштовані в [`src/config.ts`](src/config.ts). Поле `EMBEDDING_API_KEY` є в конфігурації, але код не передає його клієнту Ollama.

## Індексація

Поклади Markdown-файли в `books/`: кожна безпосередня підпапка — окрема книга. Вкладені папки книги також скануються. Файли безпосередньо в `books/` і підпапки без Markdown пропускаються; розширення `.md` перевіряється без урахування регістру.

```text
books/
  my-book/
    chapter-01.md
    chapter-02.md
```

```bash
vp run memory index
vp run memory index --chunk-size 1000
vp run memory index /path/to/books
vp run memory index /path/to/books --clean
```

`index [BOOKS_DIRECTORY]` типово читає `books/`, зберігає книги й чанки в БД та створює embeddings для нових або змінених чанків. Для кожної книги друкується підсумок:

```text
Indexed "my-book": 12 chunks, 12 embeddings
```

Кількість `chunks` у підсумку означає нові або оновлені чанки цього запуску. Незмінні чанки повторно не записуються й не отримують нових embeddings.

Поділ використовує стратегію `document-structure` за заголовками (`heading`). `--chunk-size` задає `maxChunkSize`: додатне безпечне ціле число, типово `2000` одиниць UTF-16, не токенів. Завеликі структурні блоки додатково розбиває `officeparser`. Налаштування `chunkOverlap` наразі не передається парсеру.

`--clean` перед записом видаляє всі попередні чанки кожної знайденої книги та пов’язані embeddings. Використовуй його для повної переіндексації після зміни моделі, невдалої генерації embeddings або видалення файлів. Без цього прапорця старі чанки видалених файлів чи скорочених документів залишаються в БД. Повністю видалені книги й папки, у яких більше немає Markdown, `--clean` не очищає.

## Пошук

```bash
vp run memory search "керування пам’яттю"
vp run memory search "керування пам’яттю" --limit 5
```

Пошук поєднує SQLite FTS5/BM25 і векторний пошук за косинусною відстанню через `sqlite-vec`. Позиції в обох списках об’єднуються за Reciprocal Rank Fusion (RRF).

Команда повертає JSON-масив із полями `id`, `text`, `sourceFile` (абсолютний шлях до файла) і `score` (оцінка RRF). `--limit` — додатне безпечне ціле число, типово `10`.

Для кожного запиту створюється embedding через Ollama, тому пошук потребує доступної моделі та `EMBEDDING_MODEL`. Векторна частина використовує лише embeddings із поточною моделлю й розмірністю.

## База даних

Команди `index` і `search` відкривають SQLite-файл `.data/memory.sqlite` та автоматично застосовують міграції з `drizzle/`. Каталог `.data/` CLI створює сам. Папка `drizzle/` має бути доступна поруч із `dist/`.

Схема в [`src/db/schema.ts`](src/db/schema.ts) містить таблиці `books`, `chunks` і `embeddings`. Окремий індекс `chunks_fts` синхронізується з текстом чанків через тригери. Вектори зберігаються як Float32 BLOB разом із назвою моделі та розмірністю.

```bash
vp run db:generate  # згенерувати міграцію після зміни схеми
mkdir -p .data     # потрібно для окремого запуску db:migrate на новому checkout
vp run db:migrate  # застосувати міграції та перевірити об’єкти FTS5
```

`db:migrate` після успішних міграцій запускає [`scripts/ensure-fts.ts`](scripts/ensure-fts.ts). Якщо бракує FTS-таблиці або одного з трьох тригерів, скрипт відновлює їх і перебудовує індекс із `chunks`. Автоматичні міграції під час запуску CLI цього скрипта не викликають.

## TypeScript API

```ts
import { chunkFile } from "book-memory";

const result = await chunkFile("report.pdf", { chunkSize: 1000 });
```

`chunkFile()` працює з одним файлом у форматах `officeparser`, зокрема MD, PDF, DOCX, PPTX і XLSX, та повертає `{ source, chunks, messages }`: абсолютний шлях, чанки з метаданими й діагностику парсингу. Функція не записує дані в БД й не створює embeddings. OCR не ввімкнений; індекси чанків стосуються витягнутого тексту. Пакет також експортує тип `OfficeChunk`.

## Розробка

```bash
vp run build  # збірка CLI й API в dist/
vp run dev    # збірка в режимі спостереження
vp check      # форматування, lint і типи
```

Поточний `--help` ще описує стару команду `chunk`; реалізовані CLI-команди — `index` і `search`, наведені вище.
