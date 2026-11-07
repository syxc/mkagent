import { StringEnum as publicStringEnum } from "@earendil-works/pi-ai/compat";
/**
 * The `@earendil-works/pi-ai` module extensions import: pi-ai's compat entry point plus TypeBox's `Type`, `Static` and
 * `TSchema`, which pi-ai's main entry no longer re-exports, and a `StringEnum` built with TypeBox (`TUnsafe<T>`), so
 * extensions that use it inside `Type.Object` type-check and infer as before. The TypeBox is the coding agent's own,
 * the same one extensions get for `typebox`.
 */

import { type TUnsafe, Type } from "typebox";

export * from "@earendil-works/pi-ai/compat";
export type { Static, TSchema } from "typebox";
export { Type };

/** Keep TypeBox branding and literal inference at the Native plugin boundary. */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>(publicStringEnum(values, options));
}
