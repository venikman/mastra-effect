import { Cause, Effect, Option } from "effect";

/** Run an Effect, throwing the typed error (or defect cause) on failure. */
export const runOrThrow = async <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(eff);
  if (exit._tag === "Failure") {
    const err = Cause.failureOption(exit.cause);
    if (Option.isSome(err)) throw err.value;
    throw exit.cause;
  }
  return exit.value;
};
