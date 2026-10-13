/**
 * Local oxlint rules, as an ESLint-compatible JS plugin.
 *
 * oxlint loads `.ts` plugin files directly through the Node type-stripping
 * loader, so this file needs no build step on Node 22.18+.
 * JS plugins are alpha in oxlint and are not covered by semver.
 */

/** Largest number of `case` clauses a `switch` may hold before ts-pattern is required. */
const DEFAULT_MAX_CASES = 3;

interface SwitchCase {
  /** `null` for the `default` clause. */
  test: unknown;
}

interface SwitchStatement {
  cases: SwitchCase[];
}

interface RuleContext {
  options: [{ max?: number }?];
  report(descriptor: { message: string; node: unknown }): void;
}

/**
 * A `switch` with many arms is a dispatch table pretending to be control flow.
 * `match` from ts-pattern gives the same dispatch as an expression, checks
 * exhaustiveness against the union, and narrows each arm.
 */
const maxSwitchCases = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Enforce a maximum number of `case` clauses per `switch`",
    },
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    ],
  },

  create(context: RuleContext) {
    const max = context.options[0]?.max ?? DEFAULT_MAX_CASES;

    return {
      SwitchStatement(node: SwitchStatement) {
        // The `default` clause is not a case, so it never counts against the limit.
        const cases = node.cases.filter((clause) => clause.test !== null);
        if (cases.length <= max) return;

        context.report({
          message: `This \`switch\` has ${cases.length} cases (max ${max}). Use \`match\` from ts-pattern instead.`,
          node,
        });
      },
    };
  },
};

export default {
  meta: { name: "local" },
  rules: { "max-switch-cases": maxSwitchCases },
};
