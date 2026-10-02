// Durable Object namespaces that fail as an unreachable object would, for a
// test to put in place of a real binding through `app.vars`.

/** A namespace whose stubs answer these methods with the given functions instead. */
export function overriding<N extends object>(
  real: N,
  methods: Record<string, (...args: any[]) => Promise<unknown>>,
): N {
  const namespace = real as unknown as DurableObjectNamespace;
  const overriddenStub = (id: DurableObjectId) =>
    new Proxy(namespace.get(id), {
      get: (target, property) =>
        typeof property === "string" && property in methods ? methods[property] : Reflect.get(target, property),
    });
  return new Proxy(real, {
    get: (target, property) => {
      if (property === "get") return overriddenStub;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A namespace whose objects reject every call to `method`. */
export function rejecting<N extends object>(real: N, method: string): N {
  return overriding(real, {
    [method]: async () => {
      throw new Error(`${method} failed`);
    },
  });
}
