CREATE TABLE "client_status" (
	"working_copy_id" uuid NOT NULL,
	"client" text NOT NULL,
	"repo" text NOT NULL,
	"version" text NOT NULL,
	"route" text,
	"degraded" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_status_working_copy_id_client_pk" PRIMARY KEY("working_copy_id","client")
);
--> statement-breakpoint
CREATE INDEX "client_status_reported" ON "client_status" USING btree ("reported_at");