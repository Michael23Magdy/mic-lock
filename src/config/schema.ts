import { z } from "zod";

export const tunablesSchema = z
  .object({
    ttlMs: z.number().positive(),
    heartbeatMs: z.number().positive(),
    graceMs: z.number().nonnegative(),
    gateStaleMs: z.number().positive(),
    gateAcquireTimeoutMs: z.number().positive(),
  })
  .partial();

export const resourceKindSchema = z.enum(["mutex", "pool", "semaphore"]);

export const resourceMetaSchema = z.object({
  displayName: z.string().min(1),
  kind: resourceKindSchema,
  capacity: z.number().int().positive(),
  deviceIds: z.array(z.string()).optional(),
  defaults: tunablesSchema.optional(),
  createdAt: z.number(),
});

export const globalConfigSchema = z
  .object({
    version: z.number().optional(),
    defaults: tunablesSchema.optional(),
  })
  .passthrough();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
