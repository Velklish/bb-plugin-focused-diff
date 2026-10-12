import { z } from "zod";

const completedFileChange = z.object({ item: z.object({
  type: z.literal("fileChange"), status: z.literal("completed"),
  changes: z.array(z.object({ path: z.string(), movePath: z.string().optional() })),
}) });
export function changedPaths(events: readonly { type: string; data: unknown }[]) {
  return [...new Set(events.flatMap(event => {
    if (event.type !== "item/completed") return [];
    const parsed = completedFileChange.safeParse(event.data);
    return parsed.success ? parsed.data.item.changes.flatMap(change => [change.path, ...(change.movePath ? [change.movePath] : [])]) : [];
  }))];
}
