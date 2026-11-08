CREATE TABLE "heartbeats" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "heartbeats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"repo" text NOT NULL,
	"working_copy_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "heartbeats_id_received_at_pk" PRIMARY KEY("id","received_at")
)
-- Hand-added (ADR 0002): Drizzle cannot declare partitioning. Day partitions are
-- created and dropped by the server (src/db/partitions.ts).
PARTITION BY RANGE ("received_at");
--> statement-breakpoint
CREATE INDEX "heartbeats_received_at" ON "heartbeats" USING btree ("received_at");