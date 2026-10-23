/** The lost-context notice's Reload (PanoStage); a test spies on it, as jsdom can't reload. */
export const stagePage = { reload: (): void => window.location.reload() };
