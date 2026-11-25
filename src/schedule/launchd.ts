/** The launchd label of the agent that keeps the page server running. */
export const LABEL = "com.divination.serve";

export interface PlistOptions {
  label: string;
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of `bin/divination.ts`. */
  script: string;
  /** The repo root, used as the working directory. */
  root: string;
  /** PATH for the agent. launchd starts with almost none, and the server needs `gh` and `claude`. */
  path: string;
  /** Folder for the agent's own stdout and stderr. */
  logs: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A launchd agent that runs `divination serve` at login and restarts it if it stops. */
export function plist(o: PlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.node)}</string>
    <string>${xml(o.script)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.logs)}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logs)}/launchd.err.log</string>
</dict>
</plist>
`;
}
