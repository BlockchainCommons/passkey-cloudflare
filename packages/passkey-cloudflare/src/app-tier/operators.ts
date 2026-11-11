import type { RecordSummary } from "../identity/record.ts";
import { isRecordId, type RecordId } from "../identity/secrets.ts";
import { PasskeyError, type Passkeys, type RequestContext } from "../passkeys.ts";
import type {
  BuiltInOperatorAction,
  OperatorActionName,
  OperatorLog,
  OperatorLogEntry,
  OperatorTargetKind,
} from "./operator-log.ts";

// Every operator action runs one pipeline: the caller's session, the operator
// role, a fresh step-up, the target, the action's check, the log entry, then
// the action. The entry is written before the action, so nothing is done
// without one; if it cannot be written, the action does not run. Who holds the
// operator role is the application's decision (ADR 0003): it passes its
// `OperatorRoles` in, and the library runs the rest. An application names its
// prefix once, and its own actions and target kinds carry it, so no entry it
// writes can pass for one of the library's actions or another app's.

/** Who holds the operator role. The application decides; the library only asks. */
export interface OperatorRoles {
  isOperator(recordId: RecordId): Promise<boolean>;
}

/** Why the pipeline refused an action before its entry was written. */
export type OperatorRefusal = "not-logged-in" | "not-operator" | "not-stepped-up" | "not-found";

/** An operator action's outcome: its result, or a named refusal (the pipeline's, or the action's own). */
export type OperatorOutcome<Result, Refusal extends string = never> =
  | { ok: true; value: Result }
  | { ok: false; refusal: OperatorRefusal | Refusal };

/** A name in an application's own namespace: its prefix, a colon, then the name (`forge:delete-project`). */
export type AppName<Prefix extends string> = `${Prefix}:${string}`;

/** What an action found to act on: the target it logs, and the member it concerns where there is one. */
export interface Targeted<Kind extends OperatorTargetKind = OperatorTargetKind> {
  target: { kind: Kind; id: string };
  recordId?: RecordId;
}

/** An action's own refusal, returned from `act` after its entry is written: the entry then stands for an undone action. */
export class OperatorActionRefused<Refusal extends string> {
  constructor(readonly refusal: Refusal) {}
}

/** Refuse an action from inside `act`. */
export function refuseAction<Refusal extends string>(refusal: Refusal): OperatorActionRefused<Refusal> {
  return new OperatorActionRefused(refusal);
}

/** An operator action the pipeline logs, with the names it may log under. */
interface PipelineAction<
  Result,
  Refusal extends string,
  Action extends OperatorActionName,
  Kind extends OperatorTargetKind,
> {
  /** The action's name, as its log entry records it. */
  action: Action;
  /** What the action acts on, or null for `not-found`. */
  target(): Promise<Targeted<Kind> | null>;
  /** A refusal for this target, checked before anything is logged; null to go ahead. */
  check?(found: Targeted<Kind>): Promise<Refusal | null>;
  /** The work, done once the entry is written, and its result. */
  act(found: Targeted<Kind>, operatorId: RecordId): Promise<Result | OperatorActionRefused<Refusal>>;
}

/**
 * An application's own operator action, which is logged. Its name carries the
 * application's prefix and a colon (`forge:delete-project`), and so does its
 * target's kind (`forge:project`), unless the target is a member's record
 * (`record`). The library's own actions keep plain names, which an
 * application's action cannot take.
 *
 * An action that reaches many Durable Objects (a list, a bulk change) grows
 * with the deployment: Workers Free allows 1,000 calls to Cloudflare services
 * per request, and each idle object adds a cold first touch. Prefer an answer
 * one object can give, or cap how many objects one request reaches and say in
 * the answer when it was cut short.
 */
export type LoggedOperatorAction<
  Result,
  Refusal extends string = never,
  Prefix extends string = string,
> = PipelineAction<Result, Refusal, AppName<Prefix>, "record" | AppName<Prefix>>;

/** A library action: a plain name, on a member's record. */
type BuiltInAction<Result, Refusal extends string = never> = PipelineAction<
  Result,
  Refusal,
  BuiltInOperatorAction,
  "record"
>;

/**
 * An operator read that writes no log entry. It still needs the operator role
 * and a fresh step-up. Only two kinds may skip the entry, and each says which
 * it is where a reviewer sees it:
 *
 * - `tier-0`: data already shown to others, such as member names (ADR 0010).
 *   A member's state and counts are seen one member at a time, each view
 *   logged; a view of that data for many members or items at once is not a
 *   tier-0 read.
 * - `operator-log`: reading the operator log, the operators' own record.
 *   Logging each view would add an entry every time it was opened.
 */
export interface UnloggedOperatorRead<Result> {
  unlogged: "tier-0" | "operator-log";
  read(operatorId: RecordId): Promise<Result>;
}

/** What an operator sees of a member: the record's state and counts, and the operator log entries that concern it. */
export interface MemberView {
  recordId: RecordId;
  summary: RecordSummary;
  entries: OperatorLogEntry[];
  /** Whether the name the operator gave was retired with its member, where the answer says. */
  retired?: boolean;
}

/** A built-in action's result: the member as it now stands. */
export interface MemberActed {
  member: MemberView;
}

/** One member in the list of every member name. */
export interface ListedMember {
  memberName: string;
  recordId: RecordId;
  retired: boolean;
}

export interface OperatorsConfig<Prefix extends string = string> {
  passkeys: Passkeys;
  /** Who holds the operator role, for this request. */
  roles: OperatorRoles;
  /** The operator log, under the app's storage prefix (`operatorLog(binding, storagePrefix)`). */
  log: () => DurableObjectStub<OperatorLog>;
  /**
   * The prefix the application's own action names and target kinds carry: a
   * lowercase letter, then lowercase letters, digits or hyphens (`forge`).
   * Give it as a literal, so the types hold an action to it; a prefix typed as
   * `string` is still checked when each action runs, before its entry.
   */
  appPrefix: Prefix;
}

const APP_PREFIX = /^[a-z][a-z0-9-]*$/;

/**
 * The operator pipeline, and the library's operator actions on it. Each
 * operation takes the request's session value and context, and returns an
 * outcome; the application turns it into its answer. It adds no routing, no
 * Origin check and no status codes.
 */
export function createOperators<const Prefix extends string>({
  passkeys,
  roles,
  log,
  appPrefix,
}: OperatorsConfig<Prefix>) {
  if (!APP_PREFIX.test(appPrefix)) {
    throw new TypeError(
      `An app prefix is a lowercase letter, then lowercase letters, digits or hyphens: ${JSON.stringify(appPrefix)}`,
    );
  }

  /** Whether a name is in the application's own namespace, with a name after its prefix. */
  function isAppName(name: string): boolean {
    return name.startsWith(`${appPrefix}:`) && name.length > appPrefix.length + 1;
  }

  /** Refuse a name the types should have kept out, such as one cast past them, before its entry is written. */
  function notAppName(what: string, name: string): TypeError {
    return new TypeError(
      `An app's operator ${what} carries its prefix "${appPrefix}:" and a name: ${JSON.stringify(name)}`,
    );
  }

  /** The caller's record id, if they hold the operator role and have stepped up; otherwise the refusal. */
  async function steppedUpOperator(
    sessionValue: string | null | undefined,
    ctx: RequestContext,
  ): Promise<{ ok: true; operatorId: RecordId } | { ok: false; refusal: OperatorRefusal }> {
    const principal = await passkeys.authenticate(sessionValue);
    if (!principal) return { ok: false, refusal: "not-logged-in" };
    if (!(await roles.isOperator(principal.recordId))) return { ok: false, refusal: "not-operator" };
    try {
      await passkeys.requireStepUp(ctx, sessionValue);
    } catch (e) {
      if (e instanceof PasskeyError && e.code === "step-up-required") return { ok: false, refusal: "not-stepped-up" };
      if (e instanceof PasskeyError && e.code === "not-logged-in") return { ok: false, refusal: "not-logged-in" };
      throw e;
    }
    return { ok: true, operatorId: principal.recordId };
  }

  /** Run one operator action or declared unlogged read through the pipeline. Each refusal stops it before the entry. */
  async function pipeline<Result, Refusal extends string>(
    sessionValue: string | null | undefined,
    ctx: RequestContext,
    definition: PipelineAction<Result, Refusal, OperatorActionName, OperatorTargetKind> | UnloggedOperatorRead<Result>,
    checkNames?: (action: string, kind: string) => void,
  ): Promise<OperatorOutcome<Result, Refusal>> {
    const operator = await steppedUpOperator(sessionValue, ctx);
    if (!operator.ok) return operator;
    const { operatorId } = operator;
    if ("unlogged" in definition) return { ok: true, value: await definition.read(operatorId) };
    const found = await definition.target();
    if (!found) return { ok: false, refusal: "not-found" };
    const refusal = await definition.check?.(found);
    if (refusal) return { ok: false, refusal };
    // Read the names once, check them, and log what was checked.
    const action = definition.action;
    const target = { kind: found.target.kind, id: found.target.id };
    checkNames?.(action, target.kind);
    await log().append({
      operatorId,
      action,
      target,
      ...(found.recordId ? { recordId: found.recordId } : {}),
      at: ctx.now,
    });
    const result = await definition.act(found, operatorId);
    if (result instanceof OperatorActionRefused) return { ok: false, refusal: result.refusal };
    return { ok: true, value: result };
  }

  function run<Result, Refusal extends string = never>(
    sessionValue: string | null | undefined,
    ctx: RequestContext,
    definition: LoggedOperatorAction<Result, Refusal, Prefix>,
  ): Promise<OperatorOutcome<Result, Refusal>>;
  function run<Result>(
    sessionValue: string | null | undefined,
    ctx: RequestContext,
    definition: UnloggedOperatorRead<Result>,
  ): Promise<OperatorOutcome<Result>>;
  /** Run one of the application's own operator actions, or a declared unlogged read, through the pipeline. */
  async function run<Result, Refusal extends string>(
    sessionValue: string | null | undefined,
    ctx: RequestContext,
    definition: LoggedOperatorAction<Result, Refusal, Prefix> | UnloggedOperatorRead<Result>,
  ): Promise<OperatorOutcome<Result, Refusal>> {
    if ("unlogged" in definition) return pipeline(sessionValue, ctx, definition);
    return pipeline(sessionValue, ctx, definition, (action, kind) => {
      if (!isAppName(action)) throw notAppName("action", action);
      if (kind !== "record" && !isAppName(kind)) throw notAppName("target kind", kind);
    });
  }

  /** Run one of the library's own actions through the pipeline. */
  function builtIn<Result, Refusal extends string = never>(
    sessionValue: string | null | undefined,
    ctx: RequestContext,
    definition: BuiltInAction<Result, Refusal>,
  ): Promise<OperatorOutcome<Result, Refusal>> {
    return pipeline(sessionValue, ctx, definition);
  }

  /** What an operator sees of a member. */
  async function memberView(recordId: RecordId): Promise<MemberView> {
    return { recordId, summary: await passkeys.recordSummary(recordId), entries: await log().listFor(recordId) };
  }

  /** A record as an action's target. */
  function theRecord(recordId: RecordId): Targeted<"record"> {
    return { target: { kind: "record", id: recordId }, recordId };
  }

  /** The record named by `recordId`, if it is one that exists. */
  async function recordById(recordId: unknown): Promise<Targeted<"record"> | null> {
    if (!isRecordId(recordId)) return null;
    try {
      await passkeys.recordSummary(recordId);
      return theRecord(recordId);
    } catch (e) {
      if (e instanceof PasskeyError && e.code === "not-found") return null;
      throw e;
    }
  }

  /** The record holding a member name, retired or not. */
  async function recordByMemberName(memberName: string): Promise<Targeted<"record"> | null> {
    const recordId = await passkeys.resolveMemberName(memberName);
    return recordId ? theRecord(recordId) : null;
  }

  /** The member a record target concerns; every built-in action's target has one. */
  function member(found: Targeted): RecordId {
    return found.recordId!;
  }

  return {
    run,

    /** A member's state, counts and log entries, found by member name, and whether the name is retired. */
    lookup(sessionValue: string | null | undefined, ctx: RequestContext, memberName: string) {
      return builtIn(sessionValue, ctx, {
        action: "lookup",
        target: () => recordByMemberName(memberName),
        act: async (found): Promise<MemberView> => ({
          ...(await memberView(member(found))),
          retired: await passkeys.isRetiredMemberName(memberName),
        }),
      });
    },

    /** A rebind link value for a record, and the member as it now stands. */
    createRebindLink(sessionValue: string | null | undefined, ctx: RequestContext, recordId: unknown) {
      return builtIn(sessionValue, ctx, {
        action: "create-rebind-link",
        target: () => recordById(recordId),
        act: async (found): Promise<MemberActed & { link: string }> => {
          const link = await passkeys.createRebindLink(ctx, member(found));
          return { link, member: await memberView(member(found)) };
        },
      });
    },

    suspend(sessionValue: string | null | undefined, ctx: RequestContext, recordId: unknown) {
      return builtIn(sessionValue, ctx, {
        action: "suspend",
        target: () => recordById(recordId),
        act: async (found): Promise<MemberActed> => {
          await passkeys.suspend(ctx, member(found));
          return { member: await memberView(member(found)) };
        },
      });
    },

    resume(sessionValue: string | null | undefined, ctx: RequestContext, recordId: unknown) {
      return builtIn(sessionValue, ctx, {
        action: "resume",
        target: () => recordById(recordId),
        act: async (found): Promise<MemberActed> => {
          await passkeys.resume(member(found));
          return { member: await memberView(member(found)) };
        },
      });
    },

    /** Remove a member, refused (`operator-record`) for anyone who holds the operator role. */
    remove(sessionValue: string | null | undefined, ctx: RequestContext, recordId: unknown) {
      return builtIn(sessionValue, ctx, {
        action: "remove",
        target: () => recordById(recordId),
        // An operator is taken off the role before they can be removed.
        check: async (found) => ((await roles.isOperator(member(found))) ? "operator-record" : null),
        act: async (found): Promise<MemberActed> => {
          await passkeys.remove(ctx, member(found));
          // Removal retires the name the record holds, unless it was allowed again before.
          const memberName = await passkeys.memberName(member(found));
          const retired = memberName !== null && (await passkeys.isRetiredMemberName(memberName));
          return { member: { ...(await memberView(member(found))), retired } };
        },
      });
    },

    /** Let a retired member name be registered again, refused (`name-not-retired`) for a name that is not retired. */
    allowName(sessionValue: string | null | undefined, ctx: RequestContext, memberName: string) {
      return builtIn(sessionValue, ctx, {
        action: "allow-name",
        target: () => recordByMemberName(memberName),
        check: async () => ((await passkeys.isRetiredMemberName(memberName)) ? null : "name-not-retired"),
        act: async (found) => {
          // The name can stop being retired between the check and here; the entry then stands for an undone action.
          if (!(await passkeys.allowRetiredMemberName(memberName))) return refuseAction("name-not-retired");
          return { member: { ...(await memberView(member(found))), retired: false } } satisfies MemberActed;
        },
      });
    },

    /**
     * Every member name, from one registry read: each name with its record and
     * whether it is retired. Names are shown to others, so this is a tier-0
     * read and reads no record; a member's state and counts come only from a
     * lookup, logged against their record.
     */
    memberNames(sessionValue: string | null | undefined, ctx: RequestContext) {
      return run(sessionValue, ctx, {
        unlogged: "tier-0",
        read: (): Promise<ListedMember[]> => passkeys.memberNames(),
      });
    },

    /** The operator log's recent entries. */
    logEntries(sessionValue: string | null | undefined, ctx: RequestContext) {
      return run(sessionValue, ctx, {
        unlogged: "operator-log",
        read: async (): Promise<OperatorLogEntry[]> => log().list(),
      });
    },
  };
}

export type Operators = ReturnType<typeof createOperators>;
