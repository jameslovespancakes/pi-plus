import { unknownErrorMessage } from "./unknown-error.ts";

/** Retains every failed attempt when a later retry is blocked or also fails. */
export function combinedAgentAttemptError(
  label: string,
  prior: readonly unknown[],
  finalError: unknown,
): AggregateError {
  const earlier = prior.map(unknownErrorMessage).join("; ");
  return new AggregateError(
    [...prior, finalError],
    `Workflow agent "${label}" could not complete. Earlier attempt: ${earlier}. Final failure: ${unknownErrorMessage(finalError)}`,
  );
}
