/** Cleanup must not replace the scenario's assertion failures on headless runners. */
export function trashFixture(path: string): void {
  try {
    if (Bun.spawnSync(['trash', path]).exitCode === 0) return;
  } catch {
    // The CLI can be absent even when the test itself is supported.
  }
  console.warn(`Temporary fixture retained: ${path}`);
}
