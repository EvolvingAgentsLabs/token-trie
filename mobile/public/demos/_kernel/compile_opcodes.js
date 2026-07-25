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
// Phases 1 and 2 of PLAN.md live here: enum-valued properties, and integers
// carrying both bounds. Both compile by enumeration, which is why there is a
// ceiling — see MAX_OPCODES_PER_METHOD.
//
// Enumeration gives a digit sub-trie for free: `{"column":0}` through
// `{"column":39}` share the stem `<|call|>tetris.move {"column":` and branch
// only at the digits, because TokenTrie merges common prefixes on insert. What
// it does not give you is a *slot* — a node accepting any digit and looping —
// which is what wide ranges and free strings (phase 3) need.

/** Marker for a schema this phase cannot express. */
export class UnsupportedSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

/**
 * Ceiling on how many opcodes one method may compile to.
 *
 * Enumeration is not free. Every opcode costs one async `tokenize` call when
 * the cartridge is built, so a wide range turns into a long stall before the
 * first move. The trie itself copes fine — shared prefixes mean 40 integers
 * add 40 leaves under one common stem, not 40 independent strings — but the
 * tokenizer round-trips are linear and they happen at load.
 *
 * Past this ceiling, enumeration is the wrong mechanism and the answer is a
 * real slot in the trie: a node that accepts any digit token and loops. That
 * is the same machinery free strings need, so it belongs with phase 3 rather
 * than being bolted on here.
 */
export const MAX_OPCODES_PER_METHOD = 512;

/**
 * Every combination of the enum-valued properties, in declaration order.
 *
 * Property order follows the schema's `properties` key order, because that is
 * the order the emitted JSON must use — the trie matches literal text, so
 * {"a":1,"b":2} and {"b":2,"a":1} are different opcodes.
 */
/**
 * The values one property may take.
 *
 * Two shapes are supported: an explicit `enum`, and a bounded integer range.
 * A range needs both ends — an open one has no finite enumeration, and
 * guessing a bound would silently constrain the model to something nobody
 * wrote down.
 */
function valuesFor(prop, name, where) {
  if (Array.isArray(prop?.enum) && prop.enum.length > 0) return prop.enum;

  if (prop?.type === 'integer') {
    const { minimum, maximum } = prop;
    const hasMin = Number.isInteger(minimum);
    const hasMax = Number.isInteger(maximum);

    if (!hasMin || !hasMax) {
      throw new UnsupportedSchemaError(
        `${where}: property "${name}" is an integer without ${!hasMin ? '"minimum"' : '"maximum"'}. ` +
        `An unbounded range has no finite enumeration — give it both ends, or ` +
        `declare an explicit "opcodes" array.`,
      );
    }
    if (maximum < minimum) {
      throw new UnsupportedSchemaError(
        `${where}: property "${name}" has maximum ${maximum} below minimum ${minimum}.`,
      );
    }

    const step = prop.multipleOf ?? 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new UnsupportedSchemaError(
        `${where}: property "${name}" has multipleOf ${prop.multipleOf}; expected a positive integer.`,
      );
    }

    const values = [];
    // Start at the first multiple of `step` at or above minimum, so
    // {minimum: 1, maximum: 9, multipleOf: 3} yields 3, 6, 9 — not 1, 4, 7.
    const first = Math.ceil(minimum / step) * step;
    for (let v = first; v <= maximum; v += step) values.push(v);

    if (values.length === 0) {
      throw new UnsupportedSchemaError(
        `${where}: property "${name}" admits no values — no multiple of ${step} ` +
        `falls between ${minimum} and ${maximum}.`,
      );
    }
    return values;
  }

  throw new UnsupportedSchemaError(
    `${where}: property "${name}" is neither an enum nor a bounded integer. ` +
    `Free strings are phase 3 (see PLAN.md); until then, declare an explicit ` +
    `"opcodes" array on the method to hand-write this one.`,
  );
}

function enumerateArgs(schema, where) {
  const props = schema?.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) return [{}];

  let combos = [{}];
  for (const name of names) {
    const values = valuesFor(props[name], name, where);

    // Check before building, so a wide product fails fast instead of
    // allocating its way there.
    const projected = combos.length * values.length;
    if (projected > MAX_OPCODES_PER_METHOD) {
      throw new UnsupportedSchemaError(
        `${where}: would compile to ${projected} opcodes, over the ceiling of ` +
        `${MAX_OPCODES_PER_METHOD}. Every opcode costs a tokenize call at load, ` +
        `so this would stall the cartridge build. Narrow the range, or wait for ` +
        `trie slots (phase 3) which replace enumeration for wide domains.`,
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
