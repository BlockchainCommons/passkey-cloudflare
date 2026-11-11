import {
  createOperators,
  sessionValueFrom,
  type OperatorOutcome,
  type OperatorRefusal,
  type OperatorRoles,
} from "passkey-cloudflare";
import { error, json, originChecked, type Call, type Handler, type PostRoute } from "./http.ts";
import type { ListedMember, MemberView, OperatorActed, OperatorLogEntry } from "./responses.ts";

/** An operator action's answer, as the routes send it. */
type Acted = OperatorActed & { ok: true };

// The operator routes run the library's operator pipeline (operator role,
// step-up, the target, the action's checks, the log entry, then the action)
// and turn each outcome into the answer the demo sends. The operator role
// belongs to this application, not to the identity layer (ADR 0003).

/** Who holds the operator role for one request. */
export type OperatorRolesFor = (call: Call) => OperatorRoles;

/** A comma-separated list from a var or secret, each item trimmed, empty items dropped. */
export function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The operator role as the `OPERATOR_RECORD_IDS` secret grants it: a comma-separated list of record ids. */
export function operatorRolesFromSecret({ env }: Call): OperatorRoles {
  const ids = new Set(listFrom(env.OPERATOR_RECORD_IDS));
  return { isOperator: async (recordId) => ids.has(recordId) };
}

/** Why an operator action was refused: the pipeline's refusals, and the built-in actions' own. */
type Refused = OperatorRefusal | "operator-record" | "name-not-retired";

/** The answer for each refusal, apart from `not-found`, whose message the route gives. */
const REFUSED: Record<Exclude<Refused, "not-found">, [status: number, message: string]> = {
  "not-logged-in": [401, "not logged in"],
  "not-operator": [403, "not an operator"],
  "not-stepped-up": [403, "step-up-required"],
  "operator-record": [409, "operator record"],
  "name-not-retired": [409, "name not retired"],
};

/** The answer for an outcome: the refusal's, or `answer` of its result. */
function answered<Result>(
  outcome: OperatorOutcome<Result, Refused>,
  answer: (result: Result) => Response,
  missing = "not found",
): Response {
  if (outcome.ok) return answer(outcome.value);
  if (outcome.refusal === "not-found") return error(404, missing);
  return error(...REFUSED[outcome.refusal]);
}

/** The library's operator actions for one request, with this app's roles and log. */
function operatorsFor(roles: OperatorRolesFor, call: Call) {
  return createOperators({ passkeys: call.passkeys, roles: roles(call), log: call.log, appPrefix: "demo" });
}

/** An operator action's answer, with `ok` and the member as it now stands. */
function acted(result: OperatorActed): Response {
  return json({ ok: true, ...result } satisfies Acted);
}

/** The operator routes, each answering a POST, given who holds the operator role. */
export function operatorRoutes(roles: OperatorRolesFor): Record<string, PostRoute> {
  const route = (handler: Handler) => originChecked(handler);
  const session = (call: Call) => sessionValueFrom(call.request);
  return {
    "/operator/lookup": route(async (call) =>
      answered(
        await operatorsFor(roles, call).lookup(session(call), call.ctx, call.body.memberName),
        (member) => json(member satisfies MemberView),
        "no such member",
      ),
    ),

    "/operator/rebind-links": route(async (call) =>
      answered(
        await operatorsFor(roles, call).createRebindLink(session(call), call.ctx, call.body.recordId),
        (result) => acted({ ...result, link: `${call.env.ORIGIN}/rebind#${result.link}` }),
      ),
    ),

    "/operator/suspend": route(async (call) =>
      answered(await operatorsFor(roles, call).suspend(session(call), call.ctx, call.body.recordId), acted),
    ),

    "/operator/resume": route(async (call) =>
      answered(await operatorsFor(roles, call).resume(session(call), call.ctx, call.body.recordId), acted),
    ),

    "/operator/remove": route(async (call) =>
      answered(await operatorsFor(roles, call).remove(session(call), call.ctx, call.body.recordId), acted),
    ),

    "/operator/allow-name": route(async (call) =>
      answered(await operatorsFor(roles, call).allowName(session(call), call.ctx, call.body.memberName), acted),
    ),
  };
}

/**
 * Every member name, for an operator who has stepped up, from one registry
 * read: each name with its record and whether it is retired. The library
 * declares it a tier-0 read, so it writes no log entry and reads no record. A
 * name whose registration has not completed is listed too, and a lookup of it
 * finds no member.
 */
export function operatorMembersRoute(roles: OperatorRolesFor): PostRoute {
  return originChecked(async (call) =>
    answered(await operatorsFor(roles, call).memberNames(sessionValueFrom(call.request), call.ctx), (members) =>
      json({ members: members satisfies ListedMember[] }),
    ),
  );
}

/** The operator log's recent entries, for an operator who has stepped up. */
export function operatorLogRoute(roles: OperatorRolesFor): Handler {
  return async (call) =>
    answered(await operatorsFor(roles, call).logEntries(sessionValueFrom(call.request), call.ctx), (entries) =>
      json({ entries: entries satisfies OperatorLogEntry[] }),
    );
}
