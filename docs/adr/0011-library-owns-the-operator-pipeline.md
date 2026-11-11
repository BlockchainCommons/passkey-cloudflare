# The library owns the operator pipeline; the application decides who is an operator

The server half of the operator layer is part of the library's application tier: the pipeline every operator action runs through (operator role, step-up, log entry, then the action), the `OperatorRoles` interface, the operator log Durable Object, and the six built-in actions on top of the pipeline. An application runs its own operator actions through the same pipeline, under action and target names that carry its prefix. Each application still decides who is an operator, by supplying its own `OperatorRoles` provider, and keeps its own routes and operator pane.

The ordering is the part every application would otherwise get wrong: an entry written after the action, a read with no step-up, or an action logged against the wrong target leaves the operator log unable to say what was done. This is the reasoning [ADR 0003](0003-library-owns-grants-app-owns-roles.md) gives for grants: the library carries the mechanism that is easy to get wrong, and the application keeps the role. Which reads may skip the entry follows [ADR 0010](0010-what-an-operator-sees.md): an action declares itself a tier-0 read or the operator log read in its definition, and every other action is logged.

## Considered Options

- **Keep the layer in the demo, and make the demo a package with stable exports.** Rejected: the demo's internals would become API, and an application built without the demo would get nothing.
- **A note naming the demo modules an application may rely on, with a supported surface after 0.1.0.** Rejected: the pipeline would become a convention that drifts from one application to the next, and the API question would move to a time when changing it costs more.

## Consequences

- Operator log entries name what was acted on as a target of a kind and an id, and the member it concerns where there is one, so an application's action on its own data still shows in that member's history.
- The entry is written and the action run at one point in the pipeline, so a signed operator approval over the entry can be added there once, for application actions too.
- The pipeline carries no fan-out cap. An application action that summarises many members or items prefers an answer one Durable Object can give, or caps how many objects one request reaches and says so when it was cut short.
