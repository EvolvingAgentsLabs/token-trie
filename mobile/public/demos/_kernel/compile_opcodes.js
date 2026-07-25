// kernel/compile_opcodes.js
// Compile a method's argument schema into the complete opcode strings the
// trie is built from.
//
// Until now every legal instruction was written out by hand in the manifest:
//
//   "opcodes": [
//     "<|call|>tetris.move {\"action\":\"left\"}<|/call|>\n",
//     ... four more ...
//   ]
//
// which is why there were exactly five Tetris moves. The manifest already
// declared `args_schema` for each method and nothing read it — the kernel's
// own manifest schema said so: "informational; trie enforces enumerated
// opcodes". This module makes the schema the source of truth and the opcode
// list a derived artifact.
//
// Phase 1 of PLAN.md: enum-valued properties only. That covers every existing
// cartridge, so the compiled output is expected to be byte-identical to the
// hand-written lists — see __tests__/compile_opcodes.test.js. Bounded integers
// are phase 2, free strings are phase 3, and both need trie *slots* rather
// than enumeration.

/** Marker for a schema this phase cannot express. */
export class UnsupportedSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

/**
 * Every combination of the enum-valued properties, in declaration order.
 *
 * Property order follows the schema's `properties` key order, because that is
 * the order the emitted JSON must use — the trie matches literal text, so
 * {"a":1,"b":2} and {"b":2,"a":1} are different opcodes.
 */
function enumerateArgs(schema, where) {
  const props = schema?.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) return [{}];

  let combos = [{}];
  for (const name of names) {
    const prop = props[name];
    const values = prop?.enum;

    if (!Array.isArray(values) || values.length === 0) {
      throw new UnsupportedSchemaError(
        `${where}: property "${name}" has no enum. Phase 1 compiles enum-valued ` +
        `properties only; bounded integers are phase 2 and free strings are ` +
        `phase 3 (see PLAN.md). Declare an explicit "opcodes" array on the ` +
        `method to hand-write this one in the meantime.`,
      );
    }

    const next = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [name]: value });
    }
    combos = next;
  }
  return combos;
}

/**
 * Build the opcode strings for one method.
 *
 * The wire format is `<|call|>{cartridge}.{method} {json}<|/call|>\n` with
 * compact JSON — JSON.stringify's default, no spaces — which is what the
 * hand-written lists used and what dispatch.js parses.
 */
export function compileOpcodes(cartridgeName, methodName, schema) {
  const where = `${cartridgeName}.${methodName}`;

  if (schema && schema.type && schema.type !== 'object') {
    throw new UnsupportedSchemaError(
      `${where}: args schema must be type "object", got "${schema.type}".`,
    );
  }

  return enumerateArgs(schema, where).map(
    args => `<|call|>${cartridgeName}.${methodName} ${JSON.stringify(args)}<|/call|>\n`,
  );
}

/**
 * Resolve a method's opcode list: an explicit `opcodes` array wins, otherwise
 * compile from `args_schema`.
 *
 * The explicit array stays supported on purpose. It is the escape hatch for a
 * method phase 1 cannot express, and keeping it means adding one is never
 * blocked on finishing phase 3.
 *
 * @param loadSchema async (path) => schema — resolves `args_schema` relative
 *   to the manifest. Omit it and a method without explicit opcodes will throw.
 */
export async function resolveOpcodes(cartridgeName, methodName, methodDef, loadSchema) {
  if (Array.isArray(methodDef?.opcodes) && methodDef.opcodes.length > 0) {
    return methodDef.opcodes;
  }

  const schemaPath = methodDef?.args_schema;
  if (!schemaPath) {
    throw new UnsupportedSchemaError(
      `${cartridgeName}.${methodName}: needs either an "opcodes" array or an ` +
      `"args_schema" path.`,
    );
  }
  if (typeof loadSchema !== 'function') {
    throw new UnsupportedSchemaError(
      `${cartridgeName}.${methodName}: declares args_schema "${schemaPath}" but ` +
      `no schema loader was supplied. Pass {baseUrl} or {loadSchema} to the ` +
      `Cartridge constructor.`,
    );
  }

  return compileOpcodes(cartridgeName, methodName, await loadSchema(schemaPath));
}
