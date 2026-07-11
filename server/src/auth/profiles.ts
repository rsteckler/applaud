import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { isWsl } from "../paths.js";

export interface BrowserProfile {
  browser: string;
  profile: string;
  leveldbPath: string;
  /** The profile directory itself (parent of `Local Storage`). The on-disk
   *  cookie store lives here, at `Cookies` or `Network/Cookies`. */
  profileDir: string;
  /** The browser's user-data root (parent of all profiles). `Local State`,
   *  which holds the OS-wrapped cookie encryption key, lives here. */
  userDataDir: string;
}

interface BrowserRoot {
  browser: string;
  userDataDir: string;
}

function macRoots(): BrowserRoot[] {
  const appSupport = path.join(homedir(), "Library", "Application Support");
  return [
    { browser: "Chrome", userDataDir: path.join(appSupport, "Google", "Chrome") },
    { browser: "Edge", userDataDir: path.join(appSupport, "Microsoft Edge") },
    {
      browser: "Brave",
      userDataDir: path.join(appSupport, "BraveSoftware", "Brave-Browser"),
    },
    { browser: "Arc", userDataDir: path.join(appSupport, "Arc", "User Data") },
    { browser: "Vivaldi", userDataDir: path.join(appSupport, "Vivaldi") },
  ];
}

function linuxRoots(): BrowserRoot[] {
  const cfg = path.join(homedir(), ".config");
  return [
    { browser: "Chrome", userDataDir: path.join(cfg, "google-chrome") },
    { browser: "Edge", userDataDir: path.join(cfg, "microsoft-edge") },
    {
      browser: "Brave",
      userDataDir: path.join(cfg, "BraveSoftware", "Brave-Browser"),
    },
    { browser: "Vivaldi", userDataDir: path.join(cfg, "vivaldi") },
    { browser: "Chromium", userDataDir: path.join(cfg, "chromium") },
  ];
}

function windowsRoots(localAppData: string): BrowserRoot[] {
  return [
    {
      browser: "Chrome",
      userDataDir: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      browser: "Edge",
      userDataDir: path.join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      browser: "Brave",
      userDataDir: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    },
    {
      browser: "Vivaldi",
      userDataDir: path.join(localAppData, "Vivaldi", "User Data"),
    },
  ];
}

function wslWindowsUsernames(): string[] {
  const base = "/mnt/c/Users";
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).filter((n) => {
      if (["All Users", "Default", "Default User", "Public"].includes(n)) return false;
      if (n.startsWith(".") || n.endsWith(".ini")) return false;
      try {
        return statSync(path.join(base, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function roots(): BrowserRoot[] {
  const plat = platform();
  if (plat === "darwin") return macRoots();
  if (plat === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
    return windowsRoots(localAppData);
  }
  const linux = linuxRoots();
  if (isWsl()) {
    const users = wslWindowsUsernames();
    for (const u of users) {
      linux.push(...windowsRoots(`/mnt/c/Users/${u}/AppData/Local`));
    }
  }
  return linux;
}

function listProfiles(userDataDir: string): string[] {
  if (!existsSync(userDataDir)) return [];
  try {
    const entries = readdirSync(userDataDir);
    const profiles = entries.filter((n) => {
      if (n === "Default") return true;
      if (n.startsWith("Profile ")) return true;
      return false;
    });
    const dirOnly = profiles.filter((n) => {
      try {
        return statSync(path.join(userDataDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
    dirOnly.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b)));
    return dirOnly;
  } catch {
    return [];
  }
}

export function discoverProfiles(): BrowserProfile[] {
  const found: BrowserProfile[] = [];
  for (const r of roots()) {
    for (const p of listProfiles(r.userDataDir)) {
      const profileDir = path.join(r.userDataDir, p);
      const ldb = path.join(profileDir, "Local Storage", "leveldb");
      if (existsSync(ldb)) {
        found.push({
          browser: r.browser,
          profile: p,
          leveldbPath: ldb,
          profileDir,
          userDataDir: r.userDataDir,
        });
      }
    }
  }
  return found;
}
