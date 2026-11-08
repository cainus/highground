CREATE TABLE "repos" (
	"repo" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fetch_at" timestamp with time zone,
	"last_error" text
);
