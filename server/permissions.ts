/**
 * Permission store — backend-owned grants for outbound requests.
 * Ported from CombsEngine's proxy.mjs: "always"/"deny" persist to disk,
 * "session" lives in memory, "once" allows exactly one attempt.
 *
 * Grants persist in <DATA_DIR>/permissions.json (per-app, unlike the
 * global passkey store).
 */

const VALID_GRANTS = new Set(["once", "session", "always", "deny", "reset"]);

type Verdict = "allow" | "deny" | "ask";

export class PermissionStore {
  file: string;
  persisted: Record<string, string>;
  session: Map<string, string>;
  onceAllowed: Set<string>;

  constructor(file: string) {
    this.file = file;
    this.persisted = {};
    this.session = new Map();
    this.onceAllowed = new Set();
  }

  async load(): Promise<void> {
    try {
      this.persisted = JSON.parse(await Deno.readTextFile(this.file));
    } catch { /* first run */ }
  }

  check(scope: string): Verdict {
    if (this.persisted[scope] === "always") return "allow";
    if (this.persisted[scope] === "deny") return "deny";
    if (this.session.get(scope) === "session") return "allow";
    if (this.session.get(scope) === "deny") return "deny";
    if (this.onceAllowed.has(scope)) {
      this.onceAllowed.delete(scope); // consumed
      return "allow";
    }
    return "ask";
  }

  async decide(scope: string, grant: string): Promise<boolean> {
    if (!VALID_GRANTS.has(grant)) return false;
    if (grant === "reset") {
      delete this.persisted[scope];
      this.session.delete(scope);
      this.onceAllowed.delete(scope);
    } else if (grant === "always" || grant === "deny") {
      this.persisted[scope] = grant;
    } else if (grant === "session") {
      this.session.set(scope, "session");
    } else if (grant === "once") {
      this.onceAllowed.add(scope);
    }
    await Deno.writeTextFile(this.file, JSON.stringify(this.persisted, null, 2));
    try { await Deno.chmod(this.file, 0o600); } catch { /* windows */ }
    return true;
  }

  snapshot(): { persisted: Record<string, string>; session: Record<string, string> } {
    return { persisted: this.persisted, session: Object.fromEntries(this.session) };
  }

  static isValidGrant(grant: string): boolean {
    return VALID_GRANTS.has(grant);
  }
}
