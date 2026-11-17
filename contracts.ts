import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const pathSchema = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
export const layerSchema = z.enum(["uncommitted", "committed", "staged", "unstaged", "untracked"]);
const baseBranchSchema = z.string().min(1).max(1024).refine(value => !value.includes("\0"));
export const fileSchema = z.object({
  path: pathSchema, oldPath: pathSchema.nullable(), layer: layerSchema,
  status: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  binary: z.boolean(), notice: z.string().nullable(),
});
export const repositorySchema = z.object({
  path: pathSchema, label: z.string(), branch: z.string(), files: z.array(fileSchema).max(2000),
  commonDir: pathSchema.optional(),
  baseBranch: baseBranchSchema.nullable().default(null), comparisonError: z.string().nullable().default(null),
});
export const snapshotSchema = z.object({
  repositories: z.array(repositorySchema).max(129), errors: z.array(z.string()).max(128),
});
export const statusSchema = snapshotSchema.extend({ trackedCount: z.number().int().nonnegative(), trackingPending: z.boolean() });
export const diffSchema = z.object({ patch: z.string().nullable(), notice: z.string().nullable(), binary: z.boolean() });
const rootInput = z.object({ rootPath: pathSchema });
export const hostContract = defineRpcContract({
  resolve: {
    input: rootInput.extend({ paths: z.array(pathSchema).max(256) }),
    output: z.object({ repositories: z.array(pathSchema).max(128), errors: z.array(z.string()).max(128) }),
  },
  status: { input: rootInput.extend({ repositoryPaths: z.array(pathSchema).max(128), mergeBaseBranch: baseBranchSchema.nullable().optional() }), output: snapshotSchema },
  diff: { input: rootInput.extend({ repositoryPath: pathSchema, path: pathSchema, layer: layerSchema, baseBranch: baseBranchSchema.optional() }), output: diffSchema },
});
export const trackingSchema = z.object({
  cursor: z.number().int().nonnegative().default(0),
  repositories: z.array(z.object({ environmentId: z.string(), path: pathSchema })).max(128).default([]),
});
export const rpcContract = defineRpcContract({
  scope: { input: z.object({ threadId: z.string().min(1) }).strict(), output: z.object({ enabled: z.boolean() }) },
  status: { input: z.object({ threadId: z.string().min(1) }).strict(), output: statusSchema },
  diff: {
    input: z.object({ threadId: z.string().min(1), repositoryPath: pathSchema, path: pathSchema, layer: layerSchema, baseBranch: baseBranchSchema.optional() }).strict(),
    output: diffSchema,
  },
});
export type ChangedFile = z.infer<typeof fileSchema>;
export type RepositoryChanges = z.infer<typeof repositorySchema>;
export type Snapshot = z.infer<typeof statusSchema>;
export type FileDiff = z.infer<typeof diffSchema>;
export type Layer = z.infer<typeof layerSchema>;
