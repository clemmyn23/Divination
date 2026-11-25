// Runs in the page. Inlined by src/render/page.ts; never loaded from a URL.

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-copy]") : null;
  if (!button) return;

  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
});
