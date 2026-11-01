import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const contextNoteDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
);

export function openContextNoteDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(contextNoteDialogThreadAtom, threadRef);
}
