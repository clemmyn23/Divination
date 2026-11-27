import { esc } from "./html.ts";

/**
 * A section of a panel that its heading folds shut. `heading` is HTML. The section is
 * drawn open; the page remembers the ones I shut, by panel and `name`, and shuts them
 * again each time it loads.
 */
export function fold(name: string, heading: string, inner: string): string {
  return `<details class="fold" data-fold="${esc(name)}" open>
<summary><h3 class="group">${heading}</h3></summary>
${inner}
</details>`;
}
