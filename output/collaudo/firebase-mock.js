const auth={currentUser:null};
const listeners=new Set();
const makeUser=(email)=>({email,getIdToken:async()=>email.split('@')[0]});
export const initializeApp=()=>({});
export const getApps=()=>[];
export const getApp=()=>({});
export const getAuth=()=>auth;
export const getDatabase=()=>({});
export const getIdToken=async(user)=>user.email.split('@')[0];
export function onIdTokenChanged(a,fn){listeners.add(fn);queueMicrotask(()=>fn(auth.currentUser));return()=>listeners.delete(fn);}
export async function signInWithEmailAndPassword(a,email,password){if(!password)throw new Error('Inserisci una password di prova.');auth.currentUser=makeUser(email);for(const fn of listeners)fn(auth.currentUser);return {user:auth.currentUser};}
export async function signOut(){auth.currentUser=null;for(const fn of listeners)fn(null);}
export const ref=(db,path)=>path;
export function onValue(path,fn){queueMicrotask(()=>fn({}));return()=>{};}
