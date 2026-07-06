CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`response` text,
	`score` real,
	`max_score` real,
	`ai_notes` text,
	`auto_graded` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `answers_attempt_idx` ON `answers` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`exam_id` text NOT NULL,
	`student_id` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`score` real,
	`integrity_score` real,
	`started_at` integer,
	`submitted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attempts_exam_idx` ON `attempts` (`exam_id`);--> statement-breakpoint
CREATE INDEX `attempts_student_idx` ON `attempts` (`student_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text DEFAULT '#1e3a5f' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_tenant_idx` ON `categories` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `classes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`branch` text NOT NULL,
	`batch_start_year` integer NOT NULL,
	`section` text NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `classes_tenant_idx` ON `classes` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `exam_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`exam_id` text NOT NULL,
	`question_id` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`points` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `exam_questions_exam_idx` ON `exam_questions` (`exam_id`);--> statement-breakpoint
CREATE TABLE `exams` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`class_id` text,
	`section_ids` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`duration_min` integer DEFAULT 60 NOT NULL,
	`total_points` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `exams_tenant_idx` ON `exams` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `integrity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`type` text NOT NULL,
	`detail` text,
	`photo_url` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integrity_attempt_idx` ON `integrity_events` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`role` text NOT NULL,
	`display_id` text NOT NULL,
	`phone` text,
	`enabled` integer DEFAULT true NOT NULL,
	`permissions` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profiles_tenant_idx` ON `profiles` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`category_id` text,
	`type` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text,
	`correct` text,
	`meta` text,
	`points` integer DEFAULT 1 NOT NULL,
	`difficulty` text DEFAULT 'medium' NOT NULL,
	`topic` text,
	`is_global` integer DEFAULT true NOT NULL,
	`ai_generated` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `questions_tenant_idx` ON `questions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`judge0_key` text,
	`ai_provider` text DEFAULT 'anthropic' NOT NULL,
	`claude_key` text,
	`gemini_key` text,
	`openai_key` text,
	`judge0_limit` integer DEFAULT 1000 NOT NULL,
	`judge0_used` integer DEFAULT 0 NOT NULL,
	`ai_limit` integer DEFAULT 1000 NOT NULL,
	`ai_used` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`class_id` text,
	`roll_no` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`password` text DEFAULT 'Welcome@123' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `students_tenant_idx` ON `students` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `students_class_idx` ON `students` (`class_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL,
	`slug` text NOT NULL,
	`logo_url` text,
	`primary_color` text DEFAULT '#1e3a5f' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);