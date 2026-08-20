export const firebaseConfig = {
  apiKey: "AIzaSyDGJzeHKovstJ-bFeiTyS2-o_gYM4ZHN7g",
  authDomain: "gestionale-marinelli-stefano.firebaseapp.com",
  databaseURL: "https://gestionale-marinelli-stefano-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "gestionale-marinelli-stefano",
  storageBucket: "gestionale-marinelli-stefano.firebasestorage.app",
  messagingSenderId: "687374709778",
  appId: "1:687374709778:web:e8c29a3815a6c642a914cb",
  measurementId: "G-WD7SYSC4EN",
} as const;

export const firebaseLoginProfiles = {
  admin: { username: "admin", email: "admin@gestionale.local", role: "admin", store: null, displayName: "Amministratore" },
  viterbo: { username: "viterbo", email: "viterbo@gestionale.local", role: "viterbo", store: "Viterbo", displayName: "Cassa Viterbo" },
  "gran-sasso": { username: "gran-sasso", email: "gran-sasso@gestionale.local", role: "gran_sasso", store: "Gran Sasso", displayName: "Cassa Gran Sasso" },
} as const;

export type FirebaseUsername = keyof typeof firebaseLoginProfiles;

export function firebaseProfileFromEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase();
  return Object.values(firebaseLoginProfiles).find((profile) => profile.email === normalized) ?? null;
}

export function firebaseProfileFromUsername(username: string) {
  const normalized = username.trim().toLowerCase() as FirebaseUsername;
  return firebaseLoginProfiles[normalized] ?? null;
}

export function firebaseStoreNode(store: "Viterbo" | "Gran Sasso") {
  return store === "Viterbo" ? "viterbo" : "gran-sasso";
}
