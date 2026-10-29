# SQLite + FTS5: надійні міграції

Досліджено 29 жовтня 2026 року. Перевірені локальні версії: Drizzle Kit 0.31.11, Drizzle ORM 0.45.4, SQLite 3.53.4. Це висновки з першоджерел і локального коду; прикладну схему й робочу БД не змінено.

## Що є усталеним рішенням

Поточна модель `chunks` + external-content `chunks_fts` + три тригери відповідає прикладу SQLite. Основний текст зберігається у звичайній таблиці; FTS зберігає пошуковий індекс і читає текст через `content='chunks'`, `content_rowid='id'`. Тригери синхронізують вставку, зміну й видалення. Це стандартний спосіб інтеграції, а не обхідний прийом. [SQLite: External Content Tables](https://www.sqlite.org/fts5.html#external_content_tables).

Створення тригерів не індексує старі рядки. Для цього є `rebuild`: він перебудовує індекс із основної таблиці. Це не видалення чанків чи перерахунок embeddings. Перевірка FTS із `rank=1` порівнює індекс із зовнішнім вмістом; звичайного `SELECT count(*) FROM chunks_fts` недостатньо, бо запит без `MATCH` може читати основну таблицю. [SQLite: External Content Table Pitfalls](https://www.sqlite.org/fts5.html#external_content_table_pitfalls), [rebuild](https://www.sqlite.org/fts5.html#the_rebuild_command), [integrity-check](https://www.sqlite.org/fts5.html#the_integrity_check_command).

Готові бібліотеки обгортають ці операції у звичайний API: наприклад, `sqlite-utils enable-fts ... --create-triggers` створює індекс і тригери. [sqlite-utils: Configuring full-text search](https://sqlite-utils.datasette.io/en/4.1/cli.html#configuring-full-text-search).

## Як мігрують таблицю без втрати даних

Для змін, які потребують перебудови таблиці, SQLite документує такий порядок:

1. Вимкнути foreign keys на з’єднанні до початку транзакції.
2. Почати транзакцію; зберегти визначення залежних індексів, тригерів і views.
3. Створити нову таблицю, перенести дані з явним відображенням колонок і збереженням ключів.
4. Видалити стару таблицю й перейменувати нову.
5. Відтворити потрібні індекси, тригери та views; перевірити зовнішні ключі.
6. Зафіксувати транзакцію; повернути перевірку foreign keys.

Це штатна процедура збереження даних, а не необхідність очистити БД. Не слід спочатку перейменовувати стару таблицю: SQLite попереджає про можливі зміни посилань на неї. Не кожна зміна потребує перебудови; `ALTER COLUMN SET/DROP NOT NULL` доступний із SQLite 3.53.0. Локальний SQLite новіший, але генератор міграцій також має підтримувати цю можливість. [SQLite: ALTER TABLE](https://www.sqlite.org/lang_altertable.html).

`PRAGMA foreign_keys=OFF` усередині вже відкритої транзакції не має ефекту. Тому runner має керувати цим до запуску транзакції, а не покладатися на перший рядок SQL-файла. [SQLite: Enabling Foreign Key Support](https://www.sqlite.org/foreignkeys.html#fk_enable).

`DROP TABLE chunks` видаляє її тригери. Якщо foreign keys увімкнені, цей самий `DROP` також виконує неявне видалення рядків і може запустити `ON DELETE CASCADE`. У цій схемі це означає ризик видалення залежних embeddings. Втрата тригерів і каскадна втрата даних — різні наслідки однієї неправильно керованої перебудови. [SQLite: DROP TABLE](https://www.sqlite.org/lang_droptable.html), [схема проєкту](../../src/db/schema.ts).

Приклад зрілого runner: GRDB за замовчуванням виконує міграцію з вимкненими foreign keys, у транзакції, і перевіряє їх перед commit. Саме так бібліотека приховує повторювану механіку від автора міграцій. Це архітектурний приклад, а не пропозиція змінити мову проєкту. [GRDB: DatabaseMigrator](https://github.com/groue/GRDB.swift/blob/master/GRDB/Migration/DatabaseMigrator.swift).

Транзакційність потребує одного власника: вкладений `BEGIN` у SQLite не підтримується. Не можна просто обгорнути runner, який уже робить `BEGIN`, ще одним `BEGIN`. Перевірки й FTS-відновлення мають відбуватися до його commit або бути частиною SQL-міграції. [SQLite: Transactions](https://www.sqlite.org/lang_transaction.html).

## Що автоматизує Drizzle

Запит на декларативну підтримку SQLite virtual tables, включно з FTS5, досі відкритий. Офіційний спосіб додати непідтримуваний DDL — `generate --custom` і SQL-міграції. Вони виконуються тим самим механізмом міграцій. [Drizzle issue #2046](https://github.com/drizzle-team/drizzle-orm/issues/2046), [Custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations).

У встановленій версії генератор перебудови копіює цільові колонки, видаляє стару таблицю й перейменовує нову, але не відтворює тригери. ORM migrator сам виконує `BEGIN`/`COMMIT`/`ROLLBACK`, тому foreign keys потрібно вимкнути перед його викликом. Джерела: [SQLiteRecreateTableConvertor](/mnt/data3/Projects/memory-project/node_modules/drizzle-kit/bin.cjs:25189), [SQLiteSyncDialect.migrate](/mnt/data3/Projects/memory-project/node_modules/drizzle-orm/sqlite-core/dialect.js:659).

Цей підхід застосовують інші проєкти: Cherry Studio запускає Drizzle-міграції разом із власним SQL для FTS5 і тригерів у production та тестах. QMD, згаданий у README цього проєкту, має версійні кроки зі `BEGIN IMMEDIATE`, commit/rollback і окреме встановлення FTS-тригерів; його поточна FTS-конфігурація не тотожна external-content тут. [Cherry Studio](https://github.com/CherryHQ/cherry-studio/blob/main/docs/references/testing/database-testing.md), [QMD migrations](https://github.com/tobi/qmd/blob/main/src/store-migrations.ts), [QMD store](https://github.com/tobi/qmd/blob/main/src/store.ts).

## Що конкретно зламалося тут

Це висновки з локального коду й відтворень у пам’яті, а не загальні обмеження SQLite:

- [0002](../../drizzle/0002_chunk-search.sql) створює external-content FTS і тригери за стандартною моделлю.
- [0003](../../drizzle/0003_right_switch.sql) читає `chunk_index` зі старої таблиці, хоча [0000](../../drizzle/0000_little_kate_bishop.sql) її не містить. Запуск поточного ланцюжка на новій БД повернув `no such column: "chunk_index"`. Для нового поля потрібне явне правило заповнення старих рядків.
- Та сама `0003` перебудовує `chunks`, але не створює FTS-тригери заново. Перевірка з доданою лише в пам’яті колонкою показала три тригери до міграції й жодного після.
- [rebuild-fts.mjs](../../scripts/rebuild-fts.mjs) відновлює FTS і виконує перевірки всередині своєї транзакції. Однак [db:sync](../../package.json) запускає його окремим процесом після `push`. Ці два етапи не складають одну транзакцію.
- У `push` є окремий механізм втрати даних: додавання `NOT NULL` колонки без default до непорожньої таблиці планує `DELETE FROM`; у гілці перебудови також пропускається копіювання даних. `--force` автоматично погоджує цей ризик. Це перевірено у [встановленому Kit](/mnt/data3/Projects/memory-project/node_modules/drizzle-kit/bin.cjs:25617) та його [описі прапорця](/mnt/data3/Projects/memory-project/node_modules/drizzle-kit/bin.cjs:92157). FTS не є причиною цього рішення генератора.
- Попередня перевірка робочої БД тільки для читання виявила `chunk_index`, журнал лише до `0002` і відсутні FTS-тригери. Це розбіжність схеми й історії. Саме по собі це не доводить, що вже зникли чанки чи embeddings.

## Перевірений простіший варіант саме для цієї зміни

На встановленому SQLite 3.53.4 виконано перевірку в пам’яті: БД після `0000–0002`, два чанки й два embeddings. В одній `IMMEDIATE` транзакції додано nullable `chunk_index`, заповнено його, встановлено `NOT NULL`, знято `NOT NULL` зі `start_index`/`end_index` і замінено унікальний індекс.

Результат: ключі чанків і байти embeddings збережені, усі три тригери залишилися, FTS пройшов INSERT/UPDATE/DELETE та integrity-check, foreign keys коректні. Перебудова таблиці й FTS тут не потрібна завдяки новому native ALTER. [Підтримуваний синтаксис SQLite](https://www.sqlite.org/lang_altertable.html).

Це перевірка можливості, а не виконаний перехід робочої БД. Порядок заповнення `chunk_index` у fixture — тестове припущення; реальне правило потрібно визначити. Варіант вимагає SQLite 3.53+ на всіх цільових середовищах і явного SQL: Kit 0.31.11 не обрав його автоматично.

## Практичний висновок

Рекомендація для цього репозиторію: залишити SQLite та external-content FTS, зробити міграції відтворюваним джерелом схеми й включити залежні пошукові об’єкти в їхній життєвий цикл. Звичайний запуск CLI може автоматично застосовувати готові міграції. Генератор має допомагати з SQL, але зміни даних на кшталт заповнення нового `chunk_index` потребують визначеної семантики.

Перебудова FTS за потреби є нормальною операцією. Відновлення зниклих embeddings після кожної міграції — ні. Для приймання рішення потрібні перевірки нового створення БД, оновлення заповненої БД, збереження ключів і embeddings, та пошуку після INSERT/UPDATE/DELETE. Звичайна перевірка foreign keys не виявить уже виконаного коректного каскадного видалення, тому перевірки збереження даних мають бути окремими.

Поточний перехід із `push` назад до журналу міграцій потребує одноразового узгодження схеми й історії; це не причина видаляти всю БД. Спочатку слід підготувати й перевірити перехід на копії зі збереженням даних.
