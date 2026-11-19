# An agent's controller is a person, fixed when the agent is created

Every agent has exactly one controller, a person's identity record, and it is fixed when the agent is created. The controller is the person whose session creates the agent: no operation takes a controller as an argument, none changes an agent's controller afterwards, and an agent never controls another agent. What an agent may do within that is ADR 0002's rule: its grant and its controller's current role.

The identity record already has a kind for agents, but nothing creates one yet; this records the rule agents will be built to.

Three reasons, all from the [passkey identity gist](https://gist.github.com/ChristopherA/dfb0f82a1223a95fa199837142e0f989) (BP-3, §4.5 Agent identities and §4.6 Invariants):

- **A person is accountable for every action.** When an agent is a peer of the person who made it, nothing connects the two. Revoking that person leaves the agent running, and the record of what it did names something no person answers for. With a controller edge, every agent action is attributed to a person, and limiting the person limits their agents.
- **Taking the controller from the session removes forgery.** Because no parameter carries the controller, a caller can only create an agent controlled by the person they have just proven to be. There is no argument to forge.
- **The data's shape keeps the edge fixed and one level deep.** No operation re-parents an agent, so the answer to who authorized an action cannot change afterwards. A controller is always a person, never an agent, so delegation is one level deep and cannot form a cycle. These hold by construction rather than by checks that could be missed.

## Considered Options

- **Agents controlled by agents.** Rejected for now: delegation would chain, and a chain needs depth limits and cycle checks that the person-only rule makes unnecessary.
- **An agent created first and claimed by a controller later**, as for an appliance provisioned before the person who will run it is known. Rejected for now: until claimed the agent would have no controller, and its controller would come from a later claim rather than from the session that created it.

Both were asked for in public #7, and are to be weighed when agents are built.

## Consequences

- Creating an agent needs a person's live session; no operation names a controller on someone else's behalf.
- Demoting or removing the controller limits all of their agents at once (ADR 0002).
- A deployment that needs nested delegation or late claiming needs a new decision that supersedes this one.
