/** The name every token is filed under in the platform's store. */
export const SERVICE = "divination";

const NAME = /^[a-z0-9_]+$/;

export function isSecretName(name: string): boolean {
  return NAME.test(name);
}

export interface StoreCommand {
  cmd: string;
  args: string[];
}

/**
 * Where a platform keeps tokens, as the two commands that reach it. Both belong to the
 * platform, not to us: `write` asks for the value itself, in the terminal, so a token
 * never passes through this program on its way in.
 */
export interface SecretStore {
  /** What the store is called in messages, such as "the macOS Keychain". */
  label: string;
  /** What to tell someone whose machine does not have the store's tool. */
  missing: string;
  /** Prints the stored value, or fails when there is none. */
  read(name: string): StoreCommand;
  /** Asks for a value in the terminal and stores it, replacing any earlier one. */
  write(name: string): StoreCommand;
}

/** Names end up on command lines and inside a script, so an odd one stops here. */
function checked(name: string): string {
  if (!isSecretName(name)) throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
  return name;
}

const keychain: SecretStore = {
  label: "the macOS Keychain",
  missing: "The security tool is part of macOS; check that /usr/bin is on your PATH.",
  read: (name) => ({ cmd: "security", args: ["find-generic-password", "-s", SERVICE, "-a", checked(name), "-w"] }),
  write: (name) => ({ cmd: "security", args: ["add-generic-password", "-U", "-s", SERVICE, "-a", checked(name), "-w"] }),
};

const keyring: SecretStore = {
  label: "the desktop keyring",
  missing: "Install it from your distribution's libsecret tools package (libsecret-tools on Debian and Ubuntu, libsecret on Fedora and Arch).",
  read: (name) => ({ cmd: "secret-tool", args: ["lookup", "service", SERVICE, "account", checked(name)] }),
  write: (name) => ({
    cmd: "secret-tool",
    args: ["store", "--label", `${SERVICE} ${checked(name)}`, "service", SERVICE, "account", name],
  }),
};

// The vault is only reachable from Windows PowerShell (powershell.exe), which every
// Windows has; the newer `pwsh` cannot load it. The scripts use single quotes only and
// no line breaks, so each survives being passed as one argument.
const VAULT = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
  "$vault = New-Object Windows.Security.Credentials.PasswordVault",
];

const credentialManager: SecretStore = {
  label: "the Windows Credential Manager",
  missing: "Windows PowerShell (powershell.exe) is part of Windows; check that it is on your PATH.",
  read: (name) => ({
    cmd: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        ...VAULT,
        `$found = $vault.Retrieve('${SERVICE}', '${checked(name)}')`,
        "$found.RetrievePassword()",
        "[Console]::Out.Write($found.Password)",
      ].join("; "),
    ],
  }),
  write: (name) => ({
    cmd: "powershell.exe",
    args: [
      "-NoProfile",
      "-Command",
      [
        ...VAULT,
        `$typed = Read-Host -AsSecureString 'Value for ${checked(name)}'`,
        "$value = [System.Net.NetworkCredential]::new('', $typed).Password",
        "if (-not $value) { exit 1 }",
        `$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', '${name}', $value)))`,
      ].join("; "),
    ],
  }),
};

/** The token store for a platform, or null where we know of none. */
export function storeFor(platform: string): SecretStore | null {
  if (platform === "darwin") return keychain;
  if (platform === "linux") return keyring;
  if (platform === "win32") return credentialManager;
  return null;
}
