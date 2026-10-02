# Server failures inside a ceremony get the uniform refusal

A ceremony ends in success or in the uniform refusal, and nothing else. When the server itself fails partway through one (a Durable Object call throws), the library logs the error, records a failure with the cause `internal-error`, undoes what it can, and returns the uniform refusal no sooner than the refusal floor. When undoing a refused ceremony's earlier writes fails, the library logs that error, runs the remaining undo steps, and records the failure with the ceremony's original cause, which says why it was refused. Each ceremony method applies this itself, so an application cannot get a 500 out of a ceremony by forgetting a wrapper.

## Considered Options

- **A distinct "try again later" (503), sent after the same floor.** Rejected: a second response shape tells a caller that the request got past the checks that come before the failing call, which is what the uniform refusal exists to hide.
- **Leave server errors as 500s.** Rejected: an unfloored 500 differs from a refusal in both status and timing.

## Consequences

- During an outage, people see ordinary refusals. The cause is visible only in the ceremony failure log and the Worker's logs, so an operator investigating a run of refusals should read both.
- Anything a failed undo leaves behind must be harmless or heal itself, because nobody is told. A member name claimed by a registration that never completed is freed when the name is next claimed or checked.
