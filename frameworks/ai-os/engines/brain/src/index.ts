import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BRAIN_VAULT_PATH = "C:/aphrody/var/brain";

export interface BrainSessionRecord {
  id: string;
  start: string;
  end: string;
  steps: number;
  files: string[];
  subagents: string[];
  toolErrors: number;
  status: string;
  quota429: boolean;
  firstUser?: string;
}

export interface BrainVaultStats {
  vaultPath: string;
  exists: boolean;
  totalSessions: number;
  markdownNotesCount: number;
  statusBreakdown: Record<string, number>;
}

export function loadBrainSessions(
  vaultPath = DEFAULT_BRAIN_VAULT_PATH,
): BrainSessionRecord[] {
  const jsonPath = join(vaultPath, "sessions.json");
  if (!existsSync(jsonPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    return Array.isArray(parsed) ? (parsed as BrainSessionRecord[]) : [];
  } catch {
    return [];
  }
}

export function queryBrainSessions(
  query: string,
  options?: {
    vaultPath?: string;
    status?: string;
    limit?: number;
  },
): BrainSessionRecord[] {
  const sessions = loadBrainSessions(options?.vaultPath);
  const q = query.trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, options?.limit ?? 25));

  return sessions
    .filter((s) => {
      if (options?.status && s.status !== options.status) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        (s.firstUser ?? "").toLowerCase().includes(q) ||
        s.files.some((f) => f.toLowerCase().includes(q)) ||
        s.subagents.some((sub) => sub.toLowerCase().includes(q))
      );
    })
    .slice(0, limit);
}

export function getBrainVaultStats(
  vaultPath = DEFAULT_BRAIN_VAULT_PATH,
): BrainVaultStats {
  if (!existsSync(vaultPath)) {
    return {
      vaultPath,
      exists: false,
      totalSessions: 0,
      markdownNotesCount: 0,
      statusBreakdown: {},
    };
  }
  const sessions = loadBrainSessions(vaultPath);
  const statusBreakdown: Record<string, number> = {};
  for (const s of sessions) {
    statusBreakdown[s.status] = (statusBreakdown[s.status] ?? 0) + 1;
  }
  const sessionsDir = join(vaultPath, "Sessions");
  const markdownNotesCount = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith(".md")).length
    : 0;

  return {
    vaultPath,
    exists: true,
    totalSessions: sessions.length,
    markdownNotesCount,
    statusBreakdown,
  };
}
