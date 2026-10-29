const REVEAL_TIMEOUT_MS = 3_000;

/**
 * Bring a section of the page a route change is about to render into view.
 * A page index button for it (aria-controls, as on Configuration) is clicked,
 * so the page's own jump applies its sticky-bar offset and focus; otherwise
 * the section is scrolled to and focused. Lazy pages render after their
 * chunk arrives, so this waits for the element (at most REVEAL_TIMEOUT_MS).
 * Returns a cancel function.
 */
export function revealSection(id: string, root: ParentNode = document): () => void {
  let frame = 0;
  const started = Date.now();
  const look = () => {
    frame = 0;
    const element = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (element) {
      const jump = root.querySelector<HTMLButtonElement>(`button[aria-controls="${CSS.escape(id)}"]`);
      if (jump) {
        jump.click();
        return;
      }
      element.scrollIntoView({ block: 'start' });
      if (!element.hasAttribute('tabindex')) element.tabIndex = -1;
      element.focus({ preventScroll: true });
      return;
    }
    if (Date.now() - started < REVEAL_TIMEOUT_MS) frame = window.requestAnimationFrame(look);
  };
  frame = window.requestAnimationFrame(look);
  return () => window.cancelAnimationFrame(frame);
}
