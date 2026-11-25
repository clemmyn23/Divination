import type { Source } from "../core/types.ts";

/**
 * Every source the tool knows about. To add a service: make a folder beside this
 * file, export a `Source` from its `index.ts`, and add it to this list.
 */
export const sources: Source<any>[] = [];
