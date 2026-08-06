/**
 * Prefer Antigravity connections with a discovered/stored `projectId` for
 * reset-aware quota routing (#7719 follow-up).
 *
 * Antigravity's Code Assist API is scoped per-project — a connection whose
 * `projectId` was never discovered (no `loadCodeAssist` round-trip has
 * completed yet, see antigravityProjectPersist.ts) cannot serve a request
 * reliably. Preferring connections that already have one avoids routing
 * reset-aware traffic to an account that will just re-trigger discovery.
 *
 * This is a preference, not a hard requirement: if none of the candidate
 * connections have a stored projectId yet (e.g. a freshly added account),
 * excluding all of them would empty the reset-aware pool entirely, which is
 * worse than routing to an undiscovered connection. Fail open to the full
 * list in that case.
 */

function hasStoredProjectId(connection: Record<string, unknown>): boolean {
  if (typeof connection.projectId === "string" && connection.projectId.trim().length > 0) {
    return true;
  }
  const providerSpecificData = connection.providerSpecificData;
  if (providerSpecificData && typeof providerSpecificData === "object") {
    const nested = (providerSpecificData as Record<string, unknown>).projectId;
    if (typeof nested === "string" && nested.trim().length > 0) return true;
  }
  return false;
}

export function preferAntigravityConnectionsWithStoredProject<
  T extends Record<string, unknown>,
>(connections: T[]): T[] {
  const withStoredProject = connections.filter(hasStoredProjectId);
  return withStoredProject.length > 0 ? withStoredProject : connections;
}
