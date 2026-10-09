import "server-only";
import { withAuthenticationDatabase } from "@/lib/db";
import type { Identity, VerifiedIdentity } from "./security";

export type SessionIdentity = Identity & { expiresAt: Date };
export interface AuthStore {
  registerFlow(stateHash: string, expiresAt: Date): Promise<void>;
  consumeFlow(stateHash: string): Promise<boolean>;
  createSession(identity: VerifiedIdentity, tokenHash: string): Promise<Identity>;
  resolveSession(tokenHash: string): Promise<SessionIdentity | null>;
  revokeSession(tokenHash: string): Promise<void>;
}

export const authenticationStore: AuthStore = {
  async registerFlow(stateHash, expiresAt) {
    await withAuthenticationDatabase((database) => database.query("SELECT public.auth_register_flow($1, $2)", [stateHash, expiresAt]));
  },
  async consumeFlow(stateHash) {
    const result = await withAuthenticationDatabase((database) => database.query<{ consumed: boolean }>("SELECT public.auth_consume_flow($1) AS consumed", [stateHash]));
    return result.rows[0]?.consumed === true;
  },
  async createSession(identity, tokenHash) {
    const result = await withAuthenticationDatabase((database) => database.query<{ user_id: string; email: string; display_name: string | null }>(
      "SELECT * FROM public.auth_create_session($1,$2,$3,$4,$5,$6,$7)",
      [identity.issuer, identity.subject, identity.email, true, identity.displayName, tokenHash, identity.expiresAt],
    ));
    const user = result.rows[0];
    if (!user) throw new Error("Session creation failed.");
    return { userId: user.user_id, email: user.email, displayName: user.display_name };
  },
  async resolveSession(tokenHash) {
    const result = await withAuthenticationDatabase((database) => database.query<{ user_id: string; email: string; display_name: string | null; expires_at: Date }>(
      "SELECT * FROM public.auth_resolve_session($1)", [tokenHash],
    ));
    const user = result.rows[0];
    return user ? { userId: user.user_id, email: user.email, displayName: user.display_name, expiresAt: user.expires_at } : null;
  },
  async revokeSession(tokenHash) {
    await withAuthenticationDatabase((database) => database.query("SELECT public.auth_revoke_session($1)", [tokenHash]));
  },
};
