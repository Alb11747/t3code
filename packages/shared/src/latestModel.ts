// Fork: lets scheduled tasks follow the newest model of a family, such as gpt-6.1-sol -> gpt-6.2-sol.
// Only these strict shapes take part, so variants like gpt-6-chat-thinking never move. A custom
// `[1m]` slug does not either: providers list 1M context as an option, never as a `[1m]` slug.
const CODEX_FAMILY = /^(openai\.)?gpt-(\d+)(?:\.(\d+))?-(sol|terra|luna|astra)$/;
const CLAUDE_FAMILY = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

interface ModelFamilyVersion {
  readonly family: string;
  readonly name: string;
  readonly major: number;
  readonly minor: number;
}

function parseModelFamily(slug: string): ModelFamilyVersion | null {
  const codex = CODEX_FAMILY.exec(slug);
  if (codex) {
    const [, prefix = "", major, minor = "0", name = ""] = codex;
    return { family: `${prefix}gpt-${name}`, name, major: Number(major), minor: Number(minor) };
  }
  const claude = CLAUDE_FAMILY.exec(slug);
  if (claude) {
    const [, name = "", major, minor = "0"] = claude;
    return { family: `claude-${name}`, name, major: Number(major), minor: Number(minor) };
  }
  return null;
}

/** The family's display name, such as "Sol" or "Opus", or null when the slug cannot follow one. */
export function modelFamilyName(slug: string): string | null {
  const name = parseModelFamily(slug)?.name;
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

const isNewer = (a: ModelFamilyVersion, b: ModelFamilyVersion) =>
  a.major > b.major || (a.major === b.major && a.minor > b.minor);

/**
 * The newest model in `models` of the slug's family when it is newer than the slug, or when the
 * slug is no longer listed (a model that was withdrawn); otherwise the slug itself.
 */
export function resolveLatestFamilyModel(
  slug: string,
  models: ReadonlyArray<{ readonly slug: string }>,
): string {
  const current = parseModelFamily(slug);
  if (current === null) return slug;
  let best: { readonly slug: string; readonly version: ModelFamilyVersion } | null = null;
  let listed = false;
  for (const model of models) {
    listed ||= model.slug === slug;
    const candidate = parseModelFamily(model.slug);
    if (
      candidate?.family === current.family &&
      (best === null || isNewer(candidate, best.version))
    ) {
      best = { slug: model.slug, version: candidate };
    }
  }
  if (best === null) return slug;
  return !listed || isNewer(best.version, current) ? best.slug : slug;
}
