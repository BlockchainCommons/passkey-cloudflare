# Agents are confined to a grant, not only accountable

An agent can do only what is in both its grant (a subset of capabilities its controller gave it, on specific canvases) and its controller's current role, evaluated at request time. This departs from the reference system this design descends from, where an agent carries its controller's full standing and delegation provides accountability, not confinement. We chose confinement because agents here include LLMs acting on shared canvases, and a misled or confused agent should do bounded damage: an agent granted "organize" cannot delete cards or invite people.

## Consequences

- Attribution is unchanged: every action is still attributed to the controller, with the agent recorded as the actor.
- Demoting or removing the controller shrinks every one of their agents' effective power immediately; no grant outlives the controller's own role.
- Capabilities must be named finely enough to grant separately (for example organize, edit, export), rather than only as whole roles.
