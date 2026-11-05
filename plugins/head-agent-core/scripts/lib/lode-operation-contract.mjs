import { OPERATION_NAME_PAIRS } from "../../compat/head/public-names.mjs";

export const OPERATION_DESCRIPTORS = OPERATION_NAME_PAIRS;
const descriptors = new Map(OPERATION_DESCRIPTORS.flatMap(item => [[item.legacyName, item], [item.canonicalName, item]]));
export function resolveOperation(name) { return descriptors.get(name) ?? null; }
