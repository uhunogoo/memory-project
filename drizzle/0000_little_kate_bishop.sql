CREATE TABLE `books` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`source_directory` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_source_directory_unique` ON `books` (`source_directory`);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY NOT NULL,
	`book_id` integer NOT NULL,
	`source_file` text NOT NULL,
	`text` text NOT NULL,
	`start_index` integer NOT NULL,
	`end_index` integer NOT NULL,
	`metadata` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_book_file_range_unique` ON `chunks` (`book_id`,`source_file`,`start_index`,`end_index`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` integer PRIMARY KEY NOT NULL,
	`chunk_id` integer NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`embedding` blob NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
