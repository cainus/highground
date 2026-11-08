CREATE TABLE "collision_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "collision_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"pair_key" text NOT NULL,
	"repo" text NOT NULL,
	"path" text NOT NULL,
	"a_id" text NOT NULL,
	"a_working_copy_id" uuid NOT NULL,
	"a_actor" jsonb NOT NULL,
	"a_author" text NOT NULL,
	"a_kind" text NOT NULL,
	"b_id" text NOT NULL,
	"b_working_copy_id" uuid NOT NULL,
	"b_actor" jsonb NOT NULL,
	"b_author" text NOT NULL,
	"b_kind" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"confirmed" boolean,
	"approximate" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"changed_course" boolean DEFAULT false NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "collision_events_open_pair" ON "collision_events" USING btree ("pair_key") WHERE "collision_events"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "collision_events_repo_started" ON "collision_events" USING btree ("repo","started_at");--> statement-breakpoint
CREATE INDEX "collision_events_ended" ON "collision_events" USING btree ("ended_at");