# The library owns agent grants; the application owns roles and capability names

The library stores agents, their controllers and their grants, and answers whether an agent's grant includes a capability on a resource. The application names the capabilities and resources, defines roles, and makes the final decision: the agent's grant AND its controller's current role. This keeps the identity layer ignorant of roles, while giving every application confined agents without rebuilding them.

## Considered Options

- **Identity only.** The library provides agents and controllers, and each application builds its own grants. A cleaner boundary, but every application would repeat the part most likely to be done wrong.
- **Library owns roles too.** A full authorization library. Rejected: authorization policy must be able to change without touching credential validation.
