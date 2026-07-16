/**
 * Tiny module-level registry for the CURRENT live {@link HarnessRuntime}.
 *
 * This lives in its own module (rather than on `index.ts`) so that leaf
 * modules like `tools/registration.ts` can read the live runtime WITHOUT
 * value-importing `index.ts`. `index.ts` value-imports the host SDK
 * (`openclaw/plugin-sdk/plugin-entry`), which is only present at install
 * time inside the gateway; importing it from unit tests / tooling throws
 * `Cannot find package 'openclaw'`. Keeping the registry SDK-free means
 * tests can import the tool registrations directly.
 *
 * Why a live registry at all: tool closures capture the `runtime` they were
 * registered with. On a plugin re-register the previous generation is torn
 * down and its state DB is closed. A stale closure touching that closed
 * handle throws `node:sqlite`'s "database is not open". Resolving the live
 * runtime here means tools always hit the OPEN handle.
 */

// Use a structural type to avoid a value import of index.ts (which would pull
// in the host SDK). Only `state` (with the open-guard) and `config` are read
// through the live path; keep this intentionally minimal and `unknown`-typed
// so this module has ZERO heavy imports.
export interface RuntimeLike {
  state: { db: unknown; isOpen: () => boolean };
  [key: string]: unknown;
}

let currentRuntime: RuntimeLike | null = null;

/** Publish the live runtime generation. Called on every (re-)register. */
export function setCurrentRuntime(rt: RuntimeLike | null): void {
  currentRuntime = rt;
}

/** Resolve the live runtime generation, or null before first register. */
export function getCurrentRuntime(): RuntimeLike | null {
  return currentRuntime;
}
