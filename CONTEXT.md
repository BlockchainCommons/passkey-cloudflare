# Passkey identity for collaborative apps

A passkey identity library for collaborative web applications, and a shared card canvas that demonstrates it. The identity layer answers only which principal is presenting; each application decides what that principal may do.

## Identity

**Principal**:
The authenticated subject of a request: either a person or an agent.
_Avoid_: principle, user (when the subject may be an agent)

**Person**:
A principal that is a natural person and proves itself with passkeys. Every agent's controller is a person.
_Avoid_: human, member, user

**Member name**:
The name a person chooses at registration, unique ignoring case and accents (José and jose are the same name), shown to others and used to find their identity record during recovery. It belongs to the app, not to the identity layer, and never changes once registered.
_Avoid_: handle, username, display name

**Retired name**:
A member name whose member has been removed. Nobody can register it again unless an operator allows it. A name freed by a registration that never completed was never a member's, so it is not retired.

**Identity record**:
The durable identity of one principal, which survives the loss of any single credential. Every grant and attribution refers to it.
_Avoid_: account, user, profile

**Credential**:
One passkey bound to one identity record. A person's record holds one or more and never zero.
_Avoid_: device, key (for passkeys)

**Recovery code**:
A single-use deferred credential, shown once, that rebinds a new passkey to an existing identity record.

**Ceremony**:
One WebAuthn exchange (registration, login, enrolment, step-up or recovery) proving control of a credential.

**Session**:
A bearer token proving a principal for a bounded time.

**Operator**:
Whoever runs a deployment. Can rebind a new passkey to an identity record after verifying the person out of band, and can suspend a principal, with every such action logged. An application role, unknown to the identity layer.
_Avoid_: admin, moderator, staff

## Delegation

**Agent**:
A principal that acts on behalf of a person, such as a service or an LLM, with its own identity record and never holding the person's passkeys.
_Avoid_: entity, bot, delegate

**Controller**:
The person an agent derives its authority from. Fixed when the agent is created and never changed.
_Avoid_: owner (reserved for canvases), principal (when meaning the person behind an agent)

**Capability**:
One named kind of action on a canvas that can be granted separately, such as organize, edit or export.
_Avoid_: permission, scope

**Grant**:
The capabilities a controller gives one of their agents on specific canvases. An agent may act only within its grant and within its controller's current role.
_Avoid_: delegation (for the thing given), token

## Canvas

**Canvas**:
An unbounded shared surface of cards that several principals view and change together, seeing each other's changes live.
_Avoid_: board, document

**Card**:
A two-sided item on a canvas: markdown on one side, an image on the other.
_Avoid_: note, tile

**Owner**:
The canvas role that manages who may take part and can delete the canvas.

**Editor**:
The canvas role that creates, moves, edits and deletes cards.

**Viewer**:
The canvas role that sees the canvas and its live changes without changing anything.

**Invitation**:
A single-use, expiring link that admits whoever redeems it to one canvas in one role, after they log in or register.
_Avoid_: invite code, share link

## Records and logs

**Author**:
The person an action is attributed to. For an agent's action, the author is its controller.

**Actor**:
The principal that performed an action: the author themselves, or one of the author's agents.
_Avoid_: driver, source

**Canvas export**:
A signed snapshot of a canvas that can have cards elided before it is shared, and can be verified without the server.
_Avoid_: backup, dump

**Grant record**:
A signed statement that a controller gave an agent a grant, verifiable by a third party without the server. Evidence of the grant, not the grant itself.
_Avoid_: mint record, delegation certificate

**Activity log**:
The append-only, tamper-evident history of changes to one canvas, each entry naming its author and actor.
_Avoid_: audit log, history, event log

**Ceremony failure log**:
The append-only record of refused ceremonies and their causes, kept internally while the refusal seen from outside stays uniform.
_Avoid_: error log, auth log
