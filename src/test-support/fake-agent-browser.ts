import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeBinary {
  /** Path to pass as EngineOptions.binary. */
  path: string;
  /** Every argv the fake was invoked with, one array per invocation. */
  calls(): string[][];
}

/**
 * A shell script standing in for agent-browser: it appends its argv to a log
 * file and prints whatever `stdout` says. Tests assert on the recorded argv,
 * so no browser ever launches.
 */
export function fakeAgentBrowser(stdout = "ok"): FakeBinary {
  const dir = mkdtempSync(join(tmpdir(), "bb-browser-test-"));
  const logPath = join(dir, "calls.log");
  const binPath = join(dir, "fake-agent-browser");
  writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      `printf '%b' ${JSON.stringify(stdout)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return {
    path: binPath,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(" "))
        : [],
  };
}
