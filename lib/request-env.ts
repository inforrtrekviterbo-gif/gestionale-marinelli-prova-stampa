import { AsyncLocalStorage } from "node:async_hooks";

type RequestBindings = { DB?: unknown };
type GlobalWithRequestEnv = typeof globalThis & { __gestionaleRequestEnv?: AsyncLocalStorage<RequestBindings> };

const sharedGlobal = globalThis as GlobalWithRequestEnv;
export const requestEnv = sharedGlobal.__gestionaleRequestEnv ??= new AsyncLocalStorage<RequestBindings>();

export function runWithRequestEnv<T>(bindings: RequestBindings, callback: () => T): T {
  return requestEnv.run(bindings, callback);
}

export function getRequestBindings() {
  return requestEnv.getStore();
}
