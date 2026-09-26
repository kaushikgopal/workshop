import { describe, test, expect } from "bun:test";
import { ZodError } from "zod";
import { parseStrictYaml, DefinitionError } from "../src/definition/parse-yaml.js";
import { workflowSchema, type WorkflowDefinition } from "../src/definition/schema.js";
import { parseModel } from "../src/definition/parse-model.js";
import { resolveAgent, unresolvedAgentSites } from "../src/definition/resolve-node-settings.js";
import { validateChain } from "../src/definition/check-chain.js";

/**
 * Definition-layer unit tests.
 *
 * These assert each rule by its *own* message rather than "it failed". A loose
 * assertion cannot tell the intended rule from a neighbouring one firing, and
 * several rules here did exactly that: the pure-cycle fixture fails earlier as
 * "no start node", and the merge-key fixture fails earlier as an alias, because
 * every merge key needs an alias to merge from. Pinning the message is what
 * makes the rule real.
 */
const withNodes = (nodes: string): string => `version: 1\nid: x\ndescription: d\nnodes:\n${nodes}`;

const oneNode = (extra = ""): string =>
  `version: 1\nid: x\ndescription: d\nnodes:\n  node-a:\n    run:\n      command: echo hi\n    next: null\n${extra}`;

function load(src: string): WorkflowDefinition {
  return workflowSchema.parse(parseStrictYaml(src, "test"));
}

function chain(src: string): ReturnType<typeof validateChain> {
  return validateChain(load(src));
}

// ---------------------------------------------------------------------------
// Strict YAML: every rejection names the rule that fired
// ---------------------------------------------------------------------------

describe("strict YAML — each rejection names its own rule", () => {
  test("an ampersand inside a scalar is ordinary text, never an anchor", () => {
    // The anchor rule reads lexer chunks, where a bare "&name" is a chunk and
    // "&" inside a scalar never is. A naive source-level regex would reject
    // these perfectly ordinary commands.
    const shell = load(oneNode().replace("echo hi", "echo a && echo b"));
    expect(shell.nodes["node-a"]!.run).toEqual({ command: "echo a && echo b" });

    const quoted = load(oneNode().replace("echo hi", `'curl -d "x&y" https://example.test'`));
    expect((quoted.nodes["node-a"]!.run as { command: string }).command).toContain("x&y");
  });

  test("a real alias is rejected as an alias, and names the alias", () => {
    // The fixture defines a bare anchor too, so the message proves which rule
    // fired rather than merely that something did.
    expect(() => load(oneNode("junk: &j {a: 1}\nother: *j\n"))).toThrow(/aliases are rejected .*alias \*j/);
  });

  test("a merge key with no alias is rejected as a merge key", () => {
    // Every merge key that *uses* an alias is caught by the alias rule first,
    // so this shape — the only one that reaches rejectMergeKeys — is the test
    // that actually pins it.
    expect(() => load(oneNode("junk:\n  <<: {a: 1}\n"))).toThrow(/merge keys \("<<"\) are rejected/);
  });

  test("a bare anchor definition is rejected, and names the anchor", () => {
    expect(() => load(oneNode().replace("description: d", "description: &d hello"))).toThrow(
      /anchors are rejected .*found "&d"/,
    );
  });

  test("a duplicate key is rejected", () => {
    const src = "version: 1\nid: x\ndescription: d\nid: y\nnodes:\n  node-a:\n    run:\n      command: echo hi\n    next: null\n";
    expect(() => parseStrictYaml(src, "test")).toThrow(DefinitionError);
    expect(() => parseStrictYaml(src, "test")).toThrow(/must be unique/i);
  });

  test("two execution forms on one site is a union error, not a silent pick", () => {
    const both = withNodes(
      `  node-a:\n    run:\n      agent:\n        instructions: i\n        model: "p/m:t"\n      command: echo hi\n    next: null\n`,
    );
    expect(() => load(both)).toThrow(ZodError);
    expect(() => load(both)).toThrow(/invalid_union/);
  });

  test("validator and preflight sites hold exactly one kind too", () => {
    const twoValidators = oneNode().replace(
      "    next: null",
      '    validator:\n      command: "true"\n      agent:\n        instructions: i\n        model: "p/m:t"\n    next: null',
    );
    expect(() => load(twoValidators)).toThrow(ZodError);

    const twoPreflight = oneNode().replace(
      "nodes:",
      'environment:\n  preflight:\n    command: "true"\n    timeout: 1m\n    extra: 1\nnodes:',
    );
    expect(() => load(twoPreflight)).toThrow(ZodError);
  });

  test("authored derived fields are rejected: prev_node_id and parent_node_id", () => {
    // Both are runtime-derived and must never be authored (§5).
    expect(() => load(oneNode().replace("    next: null", "    prev_node_id: node-z\n    next: null"))).toThrow(ZodError);
    expect(() => load(oneNode().replace("    next: null", "    parent_node_id: node-z\n    next: null"))).toThrow(ZodError);
  });

  test("a missing successor names the node and the ghost it points at", () => {
    const src = withNodes(`  node-a:\n    run:\n      command: echo hi\n    next: node-ghost\n`);
    expect(() => chain(src)).toThrow('node "node-a" has next "node-ghost", but no such node exists');
  });

  test("every node being a successor is 'no start node', not a cycle", () => {
    // A pure cycle has no start, so the start check fires first. Pinning this
    // message is what keeps the two rules distinguishable.
    const pureCycle = withNodes(
      `  node-a:\n    run:\n      command: echo hi\n    next: node-b\n  node-b:\n    run:\n      command: echo hi\n    next: node-a\n`,
    );
    expect(() => chain(pureCycle)).toThrow("chain has no start node (every node is a successor)");
  });

  test("a cycle reached from the start is detected by the walk, naming the revisited node", () => {
    // The only shape that reaches the revisit branch: a start that leads in.
    const reachable = withNodes(
      `  node-a:\n    run:\n      command: echo hi\n    next: node-b\n  node-b:\n    run:\n      command: echo hi\n    next: node-c\n  node-c:\n    run:\n      command: echo hi\n    next: node-b\n`,
    );
    expect(() => chain(reachable)).toThrow('chain has a cycle at node "node-b"');
  });

  test("multiple starts are rejected and both are named", () => {
    const two = withNodes(
      `  node-a:\n    run:\n      command: echo hi\n    next: null\n  node-b:\n    run:\n      command: echo hi\n    next: null\n`,
    );
    expect(() => chain(two)).toThrow(/multiple start nodes \(node-a, node-b\)/);
  });

  test("a node off the start chain is unreachable and named", () => {
    // Two null-terminated nodes are *two starts*, not unreachable nodes. The
    // shape that reaches this check is a detached cycle hanging off the single
    // start: nothing on the start chain references it, and the walk never
    // enters it because that same cycle leaves it without a start of its own.
    const detached = withNodes(
      `  node-a:\n    run:\n      command: echo hi\n    next: null\n  node-b:\n    run:\n      command: echo hi\n    next: node-c\n  node-c:\n    run:\n      command: echo hi\n    next: node-b\n`,
    );
    expect(() => chain(detached)).toThrow("unreachable nodes rejected (not on the start chain): node-b, node-c");
  });

  test("a valid chain derives order, successors, and predecessors", () => {
    const three = withNodes(
      `  node-c:\n    run:\n      command: echo c\n    next: null\n  node-a:\n    run:\n      command: echo a\n    next: node-b\n  node-b:\n    run:\n      command: echo b\n    next: node-c\n`,
    );
    // YAML order is informative, not authoritative: the chain order follows
    // the edges from the single start.
    const info = chain(three);
    expect(info.order).toEqual(["node-a", "node-b", "node-c"]);
    expect(info.next.get("node-a")).toBe("node-b");
    expect(info.next.get("node-c")).toBeNull();
    expect(info.prev.get("node-a")).toBeNull();
    expect(info.prev.get("node-c")).toBe("node-b");
  });
});

// ---------------------------------------------------------------------------
// Model strings
// ---------------------------------------------------------------------------

describe("model strings split on the first slash and the last colon", () => {
  test("a model id containing colons keeps them, and the level comes last", () => {
    expect(parseModel("provider/model:with:colons:high")).toEqual({
      provider: "provider",
      modelId: "model:with:colons",
      thinking: "high",
      full: "provider/model:with:colons:high",
    });
  });

  test("the ordinary shape round-trips", () => {
    expect(parseModel("openai-codex/gpt-5.3-codex:medium")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinking: "medium",
      full: "openai-codex/gpt-5.3-codex:medium",
    });
  });

  test("a missing provider, model, or level is rejected", () => {
    for (const bad of ["noseparator", "/model:high", "provider/:high", "provider/model", "provider/model:"]) {
      expect(() => parseModel(bad)).toThrow(/expected <provider>\/<model-id>:<thinking-level>/);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent resolution precedence
// ---------------------------------------------------------------------------

describe("agent resolution — site, then workflow default, then machine", () => {
  const machine = { harness: { command: "machine-harness" }, model: "machine/model:low" };

  test("a site wins on both fields", () => {
    const r = resolveAgent({
      node: { harness: { command: "node-harness" }, model: "node/model:high" },
      workflowDefault: { harness: { command: "wf-harness" }, model: "wf/model:mid" },
      machine,
    });
    expect(r.harnessCommand).toBe("node-harness");
    expect(r.model?.full).toBe("node/model:high");
  });

  test("precedence is per field, not per site: a node overriding only the model keeps the workflow harness", () => {
    // An implementation that resolved "which site wins" once, then took that
    // site's whole block, would return a null harness here and fail a real
    // workflow that only retunes the model.
    const r = resolveAgent({
      node: { model: "node/model:high" },
      workflowDefault: { harness: { command: "wf-harness" }, model: "wf/model:mid" },
      machine,
    });
    expect(r.harnessCommand).toBe("wf-harness");
    expect(r.model?.full).toBe("node/model:high");
  });

  test("a node overriding only the harness keeps the workflow model", () => {
    const r = resolveAgent({
      node: { harness: { command: "node-harness" } },
      workflowDefault: { harness: { command: "wf-harness" }, model: "wf/model:mid" },
      machine,
    });
    expect(r.harnessCommand).toBe("node-harness");
    expect(r.model?.full).toBe("wf/model:mid");
  });

  test("machine defaults fill whatever the workflow leaves out", () => {
    const harnessOnly = resolveAgent({ workflowDefault: { model: "wf/model:mid" }, machine });
    expect(harnessOnly.harnessCommand).toBe("machine-harness");
    expect(harnessOnly.model?.full).toBe("wf/model:mid");

    const bare = resolveAgent({ machine });
    expect(bare.harnessCommand).toBe("machine-harness");
    expect(bare.model?.full).toBe("machine/model:low");
  });

  test("nothing anywhere resolves to nothing, not to a guess", () => {
    expect(resolveAgent({})).toEqual({ harnessCommand: null, harnessTemplate: null, model: null });
  });
});

describe("unresolved agent sites are reported per site", () => {
  const agentNode = (id: string, extra = ""): string =>
    `  ${id}:\n    run:\n      agent:\n        instructions: i\n${extra}    next: null\n`;

  test("both the run site and the validator site are checked", () => {
    const src = withNodes(
      agentNode("node-a", '        model: "p/m:t"\n') +
        '    validator:\n      agent:\n        instructions: v\n',
    );
    // The run site resolves via its own model plus the machine harness; the
    // validator site resolves nothing at all.
    const unresolved = unresolvedAgentSites(load(src), { harness: { command: "h" } });
    expect(unresolved).toEqual(['node "node-a" validator']);
  });

  test("a fully resolved workflow reports nothing", () => {
    const src = withNodes(`  node-a:\n    run:\n      agent:\n        instructions: i\n        model: "p/m:t"\n    next: null\n`);
    expect(unresolvedAgentSites(load(src), { harness: { command: "h" } })).toEqual([]);
  });

  test("a command-only workflow never reports an unresolved agent", () => {
    expect(unresolvedAgentSites(load(oneNode()), undefined)).toEqual([]);
  });
});
