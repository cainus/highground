import { ActorSchema, RangeSchema, RepoPathSchema, WarningSchema } from "@highground/core";
import { oc } from "@orpc/contract";
import { z } from "zod";

/** What a daemon answers an MCP server with: warnings in working-copy lines. */
export const RadarOutputSchema = z.object({ warnings: z.array(WarningSchema) });

const target = {
  working_copy_id: z.uuid(),
  path: RepoPathSchema,
};

export const IntentInputSchema = z.object({
  ...target,
  actor: ActorSchema,
  /** Working-copy lines; empty withdraws the intent. */
  ranges: z.array(RangeSchema).max(50),
  intent: z.string().max(280).nullable().default(null),
  ttl_seconds: z.number().int().min(5).max(300).default(60),
});

export const CheckInputSchema = z.object({
  ...target,
  ranges: z.array(RangeSchema).min(1).max(50),
});

/** The daemon's local endpoint, for MCP servers on this machine or in its containers. */
export const daemonContract = {
  intent: oc.input(IntentInputSchema).output(RadarOutputSchema),
  check: oc.input(CheckInputSchema).output(RadarOutputSchema),
};
