/** The repository root, so tests can spawn the CLI and read shipped examples. */
export const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
