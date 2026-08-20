import { firebaseConfig, firebaseProfileFromEmail, firebaseStoreNode } from "./firebase-config";

type FirebaseAccount = {
  localId?: string;
  email?: string;
  emailVerified?: boolean;
  disabled?: boolean;
};

export type VerifiedFirebaseIdentity = {
  uid: string;
  email: string;
  profile: NonNullable<ReturnType<typeof firebaseProfileFromEmail>>;
  idToken: string;
};

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseIdentity | null> {
  if (!idToken) return null;
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({})) as { users?: FirebaseAccount[] };
  const account = payload.users?.[0];
  const profile = firebaseProfileFromEmail(account?.email);
  if (!account?.localId || !account.email || account.disabled || !profile) return null;
  return { uid: account.localId, email: account.email.toLowerCase(), profile, idToken };
}

export async function verifiedFirebaseIdentityFromRequest(request: Request) {
  const token = bearerToken(request);
  return token ? verifyFirebaseIdToken(token) : null;
}

export async function saveSaleToRealtimeDatabase(identity: VerifiedFirebaseIdentity, sale: {
  id: number;
  receiptNo: string;
  store: "Viterbo" | "Gran Sasso";
  type: string;
  subtotal: number;
  adjustment: number;
  total: number;
  cashAmount: number;
  cardAmount: number;
  bankAmount: number;
  giftAmount: number;
  customerId: number | null;
  fiscalDocumentType: string;
  createdAt: string;
  lines: Array<Record<string, unknown>>;
}) {
  const allowedStore = identity.profile.store;
  if (identity.profile.role !== "admin" && allowedStore !== sale.store) {
    throw new Error("Profilo Firebase non autorizzato per questo negozio.");
  }
  const node = firebaseStoreNode(sale.store);
  const response = await fetch(`${firebaseConfig.databaseURL}/stores/${node}/sales/${sale.id}.json?auth=${encodeURIComponent(identity.idToken)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...sale,
      storeNode: node,
      createdBy: identity.profile.username,
      firebaseUid: identity.uid,
      syncedAt: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Sincronizzazione Firebase non riuscita (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
}

export async function clearRealtimeSales(identity: VerifiedFirebaseIdentity) {
  if (identity.profile.role !== "admin") throw new Error("Solo l'amministratore può azzerare le vendite in tempo reale.");
  for (const node of ["viterbo", "gran-sasso"] as const) {
    const response = await fetch(`${firebaseConfig.databaseURL}/stores/${node}/sales.json?auth=${encodeURIComponent(identity.idToken)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Azzeramento Firebase non riuscito (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
  }
}
