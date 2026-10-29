PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chunks` (
	`id` integer PRIMARY KEY NOT NULL,
	`book_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`source_file` text NOT NULL,
	`text` text NOT NULL,
	`start_index` integer,
	`end_index` integer,
	`metadata` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chunks`("id", "book_id", "chunk_index", "source_file", "text", "start_index", "end_index", "metadata") SELECT "id", "book_id", "chunk_index", "source_file", "text", "start_index", "end_index", "metadata" FROM `chunks`;--> statement-breakpoint
DROP TABLE `chunks`;--> statement-breakpoint
ALTER TABLE `__new_chunks` RENAME TO `chunks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_book_file_range_unique` ON `chunks` (`book_id`,`source_file`,`chunk_index`);