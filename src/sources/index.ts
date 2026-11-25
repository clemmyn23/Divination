import type { Source } from "../core/types.ts";
import { calendar } from "./calendar/index.ts";
import { github } from "./github/index.ts";

/**
 * Every source the tool knows about. To add a service: make a folder beside this
 * file, export a `Source` from its `index.ts`, and add it to this list.
 */
export const sources: Source<any>[] = [calendar, github];
