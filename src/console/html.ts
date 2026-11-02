/**
 * A tiny, dependency-free HTML builder.
 *
 * Every interpolation is escaped unless it is already an `Html` value, so a
 * member name, a request reason or an audit payload can never inject markup.
 * Markup is written as a tagged template, which keeps the page modules close to
 * the HTML they produce.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

/** Mark trusted markup as safe. Only call this with strings this package built. */
export function raw(value: string): Html {
  return new Html(value);
}

export function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return escapeHtml(value);
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    out += render(values[index]);
    out += strings[index + 1] ?? "";
  }
  return new Html(out);
}

/** Join values without separators; children are escaped like any interpolation. */
export function join(values: unknown[]): Html {
  return new Html(values.map(render).join(""));
}

/** Join class names, dropping empty entries. */
export function classes(...values: Array<string | false | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join(" ");
}

/** Render a block only when the condition holds. */
export function when(condition: boolean, content: () => Html): Html {
  return condition ? content() : new Html("");
}
