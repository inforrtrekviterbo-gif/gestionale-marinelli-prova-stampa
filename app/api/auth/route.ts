import { firebaseProfileFromEmail } from "../../../lib/firebase-config";
import { verifyFirebaseIdToken } from "../../../lib/firebase-server";
import { createSession, currentUser, database, ensureDatabase, json, removeSession, type SessionUser } from "../../../lib/runtime-db";

type LoginBody = { action?: string; idToken?: string };

async function applicationUserForEmail(email: string) {
  const profile = firebaseProfileFromEmail(email);
  if (!profile) return null;
  let user = await database().prepare(`SELECT id, username, display_name AS displayName, role, store, must_change_password AS mustChangePassword FROM users WHERE username = ?`)
    .bind(profile.username).first<SessionUser>();
  if (!user) {
    await database().prepare(`INSERT OR IGNORE INTO users (username, display_name, role, store, password_salt, password_hash, password_iterations, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, 100000, 0, ?)`)
      .bind(profile.username, profile.displayName, profile.role, profile.store, crypto.randomUUID(), crypto.randomUUID(), new Date().toISOString()).run();
    user = await database().prepare(`SELECT id, username, display_name AS displayName, role, store, must_change_password AS mustChangePassword FROM users WHERE username = ?`)
      .bind(profile.username).first<SessionUser>();
  }
  return user ? { ...user, mustChangePassword: 0 } : null;
}

export async function GET(request: Request) {
  return json({ user: await currentUser(request) }, 200, { "Cache-Control": "private, no-store, max-age=0" });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json().catch(() => ({}))) as LoginBody;
  if (body.action === "logout") {
    await removeSession(request);
    return json({ ok: true }, 200, { "Set-Cookie": "gestionale_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }
  if (body.action !== "firebase-login" || !body.idToken) return json({ error: "Accesso Firebase richiesto." }, 400);

  const identity = await verifyFirebaseIdToken(body.idToken);
  if (!identity) return json({ error: "Credenziali Firebase non valide o profilo non autorizzato." }, 401);
  const user = await applicationUserForEmail(identity.email);
  if (!user) return json({ error: "Profilo gestionale non autorizzato." }, 403);

  const session = await createSession(user.id, 55 * 60);
  return json({ user }, 200, { "Set-Cookie": session.cookie });
}
