CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"avatar_url" text NOT NULL,
	"emails" jsonb NOT NULL,
	"token" "bytea" NOT NULL,
	"refresh_token" "bytea",
	"token_expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"refreshing_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
