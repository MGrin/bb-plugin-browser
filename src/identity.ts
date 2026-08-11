/** The plugin id bb installs this under; also the CLI command name. */
export const pluginId = "browser";
/** Namespace isolating plugin-owned agent-browser daemons from the shell's. */
export const agentBrowserNamespace = "bb-plugin-browser";
/** Chromium launch args, applied to every profile launch. */
export const launchArgs = "--disable-blink-features=AutomationControlled";
export const defaultProfile = "main";
