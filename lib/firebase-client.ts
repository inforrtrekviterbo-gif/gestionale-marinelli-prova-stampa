"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, getIdToken, type User as FirebaseUser } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { firebaseConfig, firebaseProfileFromUsername } from "./firebase-config";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firebaseDatabase = getDatabase(app);

export function firebaseEmailForUsername(username: string) {
  return firebaseProfileFromUsername(username)?.email ?? null;
}

export async function currentFirebaseIdToken(forceRefresh = false) {
  const user = firebaseAuth.currentUser;
  return user ? getIdToken(user, forceRefresh) : null;
}

export async function firebaseAuthenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = await currentFirebaseIdToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function establishServerSession(user: FirebaseUser) {
  const idToken = await getIdToken(user, true);
  return fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "firebase-login", idToken }),
  });
}
